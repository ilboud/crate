import { Router } from 'express';
import type { Db } from '../../db/index.js';
import { setSetting, getSetting } from '../../db/index.js';
import { reassignAll, unassignedStyles } from '../../sync/taxonomy.js';
import { rebuildSimilar } from '../../sync/similar.js';
import {
  DEFAULT_MODELS,
  providerStatus,
  readBackendChoice,
  readFeel,
  storeKey,
  storeModel,
  writeBackendChoice,
  writeFeel,
  type Provider,
} from '../settings.js';

const PROVIDERS: readonly Provider[] = ['anthropic', 'openai'];

function isProvider(value: unknown): value is Provider {
  return typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value);
}

/**
 * Taxonomy administration.
 *
 * Every mutation re-derives release.primary_group immediately — the collection
 * is small enough that a full reassignment is sub-second, which avoids any
 * stale-derived-state problem. Similarity is rebuilt too, since it reads the
 * group assignment.
 */
function applyTaxonomyChange(db: Db): { counts: Record<string, number> } {
  const counts = reassignAll(db);
  rebuildSimilar(db);
  return { counts: Object.fromEntries(counts) };
}

export function adminRoutes(db: Db): Router {
  const r = Router();

  /* ------------------------------------------------------------- feel */

  r.get('/settings', (_req, res) => {
    res.json({
      feel: readFeel(db),
      chat: {
        backend: readBackendChoice(db),
        backendFromEnv: Boolean(process.env.CHAT_BACKEND),
        providers: PROVIDERS.map((p) => providerStatus(db, p)),
        defaultModels: DEFAULT_MODELS,
        mcpUrl: process.env.MCP_URL ?? null,
      },
    });
  });

  r.put('/settings/feel', (req, res) => {
    try {
      return res.json({ feel: writeFeel(db, req.body ?? {}) });
    } catch (err) {
      return res.status(400).json({ error: (err as Error).message });
    }
  });

  /* -------------------------------------------------------- chat keys */

  /**
   * Writes a key or clears it. There is deliberately no route that returns a
   * stored key: on a LAN app with no login, a secret that can be read back
   * over HTTP is a secret anyone on the wifi can take.
   */
  r.put('/settings/key', (req, res) => {
    const { provider, key } = req.body ?? {};
    if (!isProvider(provider)) {
      return res.status(400).json({ error: 'provider must be anthropic or openai' });
    }
    if (key !== null && typeof key !== 'string') {
      return res.status(400).json({ error: 'key must be a string, or null to clear' });
    }
    const trimmed = typeof key === 'string' ? key.trim() : null;
    if (trimmed !== null && trimmed.length < 8) {
      return res.status(400).json({ error: 'that does not look like an API key' });
    }
    storeKey(db, provider, trimmed);
    return res.json({ providers: PROVIDERS.map((p) => providerStatus(db, p)) });
  });

  r.put('/settings/chat', (req, res) => {
    const { backend, provider, model } = req.body ?? {};
    if (backend !== undefined) {
      if (!isProvider(backend)) {
        return res.status(400).json({ error: 'backend must be anthropic or openai' });
      }
      writeBackendChoice(db, backend);
    }
    if (model !== undefined) {
      if (!isProvider(provider)) {
        return res.status(400).json({ error: 'provider required when setting a model' });
      }
      storeModel(db, provider, String(model));
    }
    return res.json({
      backend: readBackendChoice(db),
      providers: PROVIDERS.map((p) => providerStatus(db, p)),
    });
  });

  r.get('/taxonomy', (_req, res) => {
    const groups = db
      .prepare('SELECT id, name, sort_order, hidden FROM taxonomy_group ORDER BY sort_order, id')
      .all() as Array<{ id: number; name: string; sort_order: number; hidden: number }>;

    const styles = db
      .prepare(
        `SELECT ts.style AS style, ts.group_id AS group_id,
                (SELECT COUNT(DISTINCT rs.release_id) FROM release_style rs WHERE rs.style = ts.style) AS count
           FROM taxonomy_style ts ORDER BY count DESC, ts.style`,
      )
      .all();

    res.json({
      groups,
      styles,
      unassigned: unassignedStyles(db),
      hideGroupBelow: Number(getSetting(db, 'hide_group_below', '3')),
    });
  });

  r.post('/taxonomy/group', (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    if (!name) return res.status(400).json({ error: 'name required' });
    const max = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM taxonomy_group').get() as { m: number };
    try {
      const info = db
        .prepare('INSERT INTO taxonomy_group (name, sort_order, hidden) VALUES (?,?,0)')
        .run(name, max.m + 1);
      return res.status(201).json({ id: Number(info.lastInsertRowid), ...applyTaxonomyChange(db) });
    } catch {
      return res.status(409).json({ error: 'a group with that name already exists' });
    }
  });

  r.patch('/taxonomy/group/:id', (req, res) => {
    const id = Number(req.params.id);
    const exists = db.prepare('SELECT id FROM taxonomy_group WHERE id = ?').get(id);
    if (!exists) return res.status(404).json({ error: 'not found' });

    const { name, sort_order: sortOrder, hidden } = req.body ?? {};
    if (typeof name === 'string' && name.trim()) {
      db.prepare('UPDATE taxonomy_group SET name = ? WHERE id = ?').run(name.trim(), id);
    }
    if (Number.isInteger(sortOrder)) {
      db.prepare('UPDATE taxonomy_group SET sort_order = ? WHERE id = ?').run(sortOrder, id);
    }
    if (typeof hidden === 'boolean') {
      db.prepare('UPDATE taxonomy_group SET hidden = ? WHERE id = ?').run(hidden ? 1 : 0, id);
    }
    return res.json(applyTaxonomyChange(db));
  });

  r.delete('/taxonomy/group/:id', (req, res) => {
    const id = Number(req.params.id);
    const exists = db.prepare('SELECT id FROM taxonomy_group WHERE id = ?').get(id);
    if (!exists) return res.status(404).json({ error: 'not found' });
    // Styles and overrides cascade; their releases fall back to genre or
    // precedence on the reassignment below rather than becoming orphaned.
    db.prepare('DELETE FROM taxonomy_group WHERE id = ?').run(id);
    return res.json(applyTaxonomyChange(db));
  });

  r.put('/taxonomy/style', (req, res) => {
    const style = String(req.body?.style ?? '').trim();
    const groupId = req.body?.group_id;
    if (!style) return res.status(400).json({ error: 'style required' });

    if (groupId === null) {
      db.prepare('DELETE FROM taxonomy_style WHERE style = ?').run(style);
      return res.json(applyTaxonomyChange(db));
    }
    if (!Number.isInteger(groupId)) return res.status(400).json({ error: 'group_id required' });
    const group = db.prepare('SELECT id FROM taxonomy_group WHERE id = ?').get(groupId);
    if (!group) return res.status(404).json({ error: 'group not found' });

    db.prepare('INSERT OR REPLACE INTO taxonomy_style (style, group_id) VALUES (?,?)').run(style, groupId);
    return res.json(applyTaxonomyChange(db));
  });

  r.put('/override/:releaseId', (req, res) => {
    const releaseId = Number(req.params.releaseId);
    const release = db.prepare('SELECT id FROM release WHERE id = ?').get(releaseId);
    if (!release) return res.status(404).json({ error: 'release not found' });

    const groupId = req.body?.group_id;
    if (groupId === null) {
      db.prepare('DELETE FROM release_override WHERE release_id = ?').run(releaseId);
      return res.json(applyTaxonomyChange(db));
    }
    if (!Number.isInteger(groupId)) return res.status(400).json({ error: 'group_id required' });
    const group = db.prepare('SELECT id FROM taxonomy_group WHERE id = ?').get(groupId);
    if (!group) return res.status(404).json({ error: 'group not found' });

    db.prepare(
      'INSERT OR REPLACE INTO release_override (release_id, group_id, note) VALUES (?,?,?)',
    ).run(releaseId, groupId, String(req.body?.note ?? ''));
    return res.json(applyTaxonomyChange(db));
  });

  r.put('/settings/hide-group-below', (req, res) => {
    const value = req.body?.value;
    if (!Number.isInteger(value) || value < 0) {
      return res.status(400).json({ error: 'value must be a non-negative integer' });
    }
    setSetting(db, 'hide_group_below', String(value));
    return res.json({ hideGroupBelow: value });
  });

  /** Export/import keeps the taxonomy diffable in git and portable. */
  r.get('/taxonomy/export', (_req, res) => {
    const groups = db
      .prepare('SELECT id, name, sort_order, hidden FROM taxonomy_group ORDER BY sort_order')
      .all() as Array<{ id: number; name: string; sort_order: number; hidden: number }>;
    const styles = db.prepare('SELECT style, group_id FROM taxonomy_style').all() as Array<{
      style: string; group_id: number;
    }>;
    const genres = db.prepare('SELECT genre, group_id FROM taxonomy_genre').all() as Array<{
      genre: string; group_id: number;
    }>;
    const byId = new Map(groups.map((g) => [g.id, g.name]));
    res.json({
      version: 1,
      groups: groups.map((g) => ({
        name: g.name,
        sort_order: g.sort_order,
        hidden: g.hidden === 1,
        styles: styles.filter((s) => s.group_id === g.id).map((s) => s.style),
        genres: genres.filter((s) => s.group_id === g.id).map((s) => s.genre),
      })),
      overrides: (db
        .prepare(
          `SELECT o.release_id AS release_id, o.group_id AS group_id, o.note AS note
             FROM release_override o`,
        )
        .all() as Array<{ release_id: number; group_id: number; note: string }>)
        .map((o) => ({ release_id: o.release_id, group: byId.get(o.group_id), note: o.note })),
    });
  });

  return r;
}
