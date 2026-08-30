import type { Db } from '../db/index.js';
import type {
  CollectionItem,
  ReleaseDetail,
  SyncResult,
} from '../shared/types.js';
import { DiscogsClient } from './discogs.js';
import { mirrorCovers } from './covers.js';
import { parseDuration, parsePosition } from './position.js';
import { reassignAll } from './taxonomy.js';
import { rebuildSimilar } from './similar.js';

export interface SyncDeps {
  client: Pick<DiscogsClient, 'getCollection' | 'getRelease'>;
  coversDir: string;
  fetchImpl?: typeof fetch;
  onProgress?: (done: number, total: number, label: string) => void;
}

export interface SyncOptions {
  username: string;
  folderId?: number;
  /** Re-fetch releases already stored, e.g. after a schema or parser change. */
  force?: boolean;
}

/** Delete every derived row for a release so it can be re-inserted cleanly. */
function clearReleaseChildren(db: Db, releaseId: number): void {
  for (const table of [
    'release_artist', 'release_label', 'release_genre',
    'release_style', 'release_format', 'track',
  ]) {
    db.prepare(`DELETE FROM ${table} WHERE release_id = ?`).run(releaseId);
  }
  db.prepare('DELETE FROM track_fts WHERE release_id = ?').run(releaseId);
  db.prepare('DELETE FROM release_fts WHERE release_id = ?').run(releaseId);
}

function artistNames(detail: ReleaseDetail): string {
  const parts: string[] = [];
  (detail.artists ?? []).forEach((a, i, arr) => {
    parts.push(a.name);
    if (a.join && i < arr.length - 1) parts.push(a.join === ',' ? ', ' : ` ${a.join} `);
  });
  return parts.join('').trim() || 'Unknown Artist';
}

/** Write one fully-fetched release and its children. Runs in a transaction. */
export function storeRelease(
  db: Db,
  detail: ReleaseDetail,
  covers: { coverPath: string | null; thumbPath: string | null },
): void {
  const write = db.transaction(() => {
    clearReleaseChildren(db, detail.id);

    db.prepare(
      `INSERT INTO release (id, master_id, title, year, cover_path, thumb_path, raw_json)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         master_id = excluded.master_id, title = excluded.title, year = excluded.year,
         cover_path = excluded.cover_path, thumb_path = excluded.thumb_path,
         raw_json = excluded.raw_json`,
    ).run(
      detail.id,
      detail.master_id ?? null,
      detail.title,
      detail.year ?? null,
      covers.coverPath,
      covers.thumbPath,
      JSON.stringify(detail),
    );

    // NOT "INSERT OR REPLACE": REPLACE deletes the existing artist row first,
    // and release_artist.artist_id cascades on delete, so re-storing a shared
    // artist would silently wipe every OTHER release's link to them.
    const upsertArtist = db.prepare(
      'INSERT INTO artist (id, name) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET name = excluded.name',
    );
    const linkArtist = db.prepare(
      'INSERT OR REPLACE INTO release_artist (release_id, artist_id, seq, join_str) VALUES (?,?,?,?)',
    );
    (detail.artists ?? []).forEach((a, i) => {
      upsertArtist.run(a.id, a.name);
      linkArtist.run(detail.id, a.id, i, a.join ?? null);
    });

    // Same cascade hazard as artist above — Columbia is shared by dozens of
    // releases, and REPLACE would drop all their label links.
    const upsertLabel = db.prepare(
      'INSERT INTO label (id, name) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET name = excluded.name',
    );
    const linkLabel = db.prepare(
      'INSERT OR IGNORE INTO release_label (release_id, label_id, catno) VALUES (?,?,?)',
    );
    for (const l of detail.labels ?? []) {
      upsertLabel.run(l.id, l.name);
      linkLabel.run(detail.id, l.id, l.catno ?? '');
    }

    const insGenre = db.prepare('INSERT OR IGNORE INTO release_genre (release_id, genre) VALUES (?,?)');
    for (const g of detail.genres ?? []) insGenre.run(detail.id, g);

    const insStyle = db.prepare('INSERT OR IGNORE INTO release_style (release_id, style) VALUES (?,?)');
    for (const s of detail.styles ?? []) insStyle.run(detail.id, s);

    const insFormat = db.prepare(
      'INSERT OR REPLACE INTO release_format (release_id, seq, name, qty, descriptions) VALUES (?,?,?,?,?)',
    );
    (detail.formats ?? []).forEach((f, i) => {
      insFormat.run(detail.id, i, f.name, Number(f.qty) || 1, JSON.stringify(f.descriptions ?? []));
    });

    const artist = artistNames(detail);
    const insTrack = db.prepare(
      `INSERT INTO track (release_id, seq, position_raw, disc, side, index_on_side, title, duration_sec)
       VALUES (?,?,?,?,?,?,?,?)`,
    );
    const insTrackFts = db.prepare(
      'INSERT INTO track_fts (title, artist, album, track_id, release_id) VALUES (?,?,?,?,?)',
    );

    // Headings and index entries carry type_ 'heading'/'index' and are not
    // playable tracks; keep only real tracks so song search stays clean.
    const tracks = (detail.tracklist ?? []).filter(
      (t) => (t.type_ ?? 'track') === 'track' && t.title.trim() !== '',
    );
    tracks.forEach((t, i) => {
      const pos = parsePosition(t.position, i + 1);
      const info = insTrack.run(
        detail.id, i, t.position ?? null, pos.disc, pos.side, pos.indexOnSide,
        t.title, parseDuration(t.duration),
      );
      insTrackFts.run(t.title, artist, detail.title, Number(info.lastInsertRowid), detail.id);
    });

    db.prepare('INSERT INTO release_fts (title, artist, release_id) VALUES (?,?,?)')
      .run(detail.title, artist, detail.id);
  });
  write();
}

/**
 * Pull the collection into SQLite.
 *
 * Incremental: only releases not already stored are fetched in full, which
 * turns a five-minute first run into a seconds-long later one.
 *
 * Failure-isolating: a release that fails to fetch is recorded in
 * sync_run.failed_ids and retried next run. It must never abort the run — the
 * Discogs API does intermittently fail mid-sync, and a partial index is worse
 * than a slightly stale one.
 */
export async function runSync(
  db: Db,
  deps: SyncDeps,
  opts: SyncOptions,
): Promise<SyncResult> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const runInfo = db
    .prepare('INSERT INTO sync_run (started_at) VALUES (?)')
    .run(startedAt);
  const runId = Number(runInfo.lastInsertRowid);

  const items: CollectionItem[] = await deps.client.getCollection(
    opts.username,
    opts.folderId ?? 0,
  );

  // 245 items but 244 releases: one record is owned twice. Instances are
  // stored separately so browsing shows each release once.
  const wanted = new Map<number, CollectionItem>();
  for (const item of items) wanted.set(item.basic_information.id, item);

  const existing = new Set(
    (db.prepare('SELECT id FROM release').all() as Array<{ id: number }>).map((r) => r.id),
  );

  const toFetch = [...wanted.keys()].filter((id) => opts.force || !existing.has(id));
  const toRemove = [...existing].filter((id) => !wanted.has(id));

  const failed: number[] = [];
  let ok = 0;

  for (const [i, releaseId] of toFetch.entries()) {
    deps.onProgress?.(i + 1, toFetch.length, `release ${releaseId}`);
    try {
      const detail = await deps.client.getRelease(releaseId);
      const basic = wanted.get(releaseId)!.basic_information;
      const covers = await mirrorCovers(
        releaseId,
        detail.cover_image ?? basic.cover_image,
        detail.thumb ?? basic.thumb,
        deps.coversDir,
        deps.fetchImpl,
      );
      storeRelease(db, detail, covers);
      ok += 1;
    } catch {
      // Recorded, not thrown: one bad release must not lose the other 243.
      failed.push(releaseId);
    }
  }

  db.transaction(() => {
    const del = db.prepare('DELETE FROM release WHERE id = ?');
    for (const id of toRemove) del.run(id);

    // Rebuild instances from scratch — cheap, and it handles copies added or
    // removed without diffing instance ids.
    db.prepare('DELETE FROM collection_item').run();
    const insItem = db.prepare(
      'INSERT OR REPLACE INTO collection_item (instance_id, release_id, folder_id, date_added) VALUES (?,?,?,?)',
    );
    const stored = new Set(
      (db.prepare('SELECT id FROM release').all() as Array<{ id: number }>).map((r) => r.id),
    );
    for (const item of items) {
      if (stored.has(item.basic_information.id)) {
        insItem.run(
          item.instance_id,
          item.basic_information.id,
          item.folder_id ?? null,
          item.date_added ?? null,
        );
      }
    }
  })();

  reassignAll(db);
  rebuildSimilar(db);

  db.prepare('UPDATE sync_run SET finished_at = ?, ok_count = ?, failed_ids = ? WHERE id = ?')
    .run(new Date().toISOString(), ok, JSON.stringify(failed), runId);

  return {
    added: ok,
    removed: toRemove.length,
    unchanged: wanted.size - toFetch.length,
    items: items.length,
    failed,
    durationMs: Date.now() - t0,
  };
}
