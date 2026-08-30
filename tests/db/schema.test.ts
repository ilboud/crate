import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, migrate, initDb, getSetting, setSetting, type Db } from '../../src/db/index.js';
import { SEED_GROUPS } from '../../src/db/seed-taxonomy.js';

describe('schema', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });
  afterEach(() => db.close());

  it('creates every expected table', () => {
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
      .all() as Array<{ name: string }>;
    const names = new Set(rows.map((r) => r.name));
    for (const t of [
      'release', 'artist', 'release_artist', 'label', 'release_label',
      'release_genre', 'release_style', 'release_format', 'track', 'similar',
      'taxonomy_group', 'taxonomy_style', 'taxonomy_genre', 'release_override',
      'setting', 'sync_run', 'track_fts', 'release_fts',
    ]) {
      expect(names, `missing table ${t}`).toContain(t);
    }
  });

  it('supports FTS5 match queries on tracks', () => {
    db.prepare(
      'INSERT INTO track_fts (title, artist, album, track_id, release_id) VALUES (?,?,?,?,?)',
    ).run('Blue In Green', 'Miles Davis', 'Kind Of Blue', 1, 100);
    db.prepare(
      'INSERT INTO track_fts (title, artist, album, track_id, release_id) VALUES (?,?,?,?,?)',
    ).run('So What', 'Miles Davis', 'Kind Of Blue', 2, 100);

    const hits = db
      .prepare('SELECT track_id FROM track_fts WHERE track_fts MATCH ?')
      .all('"blue in green"') as Array<{ track_id: number }>;
    expect(hits).toHaveLength(1);
    expect(hits[0]!.track_id).toBe(1);
  });

  it('folds diacritics so accented titles are findable by plain ASCII', () => {
    db.prepare(
      'INSERT INTO track_fts (title, artist, album, track_id, release_id) VALUES (?,?,?,?,?)',
    ).run("Ágætis Byrjun", 'Sigur Rós', 'Ágætis Byrjun', 3, 101);
    const hits = db
      .prepare('SELECT track_id FROM track_fts WHERE track_fts MATCH ?')
      .all('Agaetis OR Agætis') as Array<{ track_id: number }>;
    expect(hits.length).toBeGreaterThan(0);
  });

  it('cascades deletes from release to its children', () => {
    db.prepare('INSERT INTO release (id, title, raw_json) VALUES (1, ?, ?)').run('X', '{}');
    db.prepare(
      'INSERT INTO track (release_id, seq, title, disc) VALUES (1, 1, ?, 1)',
    ).run('T');
    db.prepare('INSERT INTO release_style (release_id, style) VALUES (1, ?)').run('Modal');

    db.prepare('DELETE FROM release WHERE id = 1').run();

    const t = db.prepare('SELECT COUNT(*) AS n FROM track').get() as { n: number };
    const s = db.prepare('SELECT COUNT(*) AS n FROM release_style').get() as { n: number };
    expect(t.n).toBe(0);
    expect(s.n).toBe(0);
  });
});

describe('taxonomy seed', () => {
  let db: Db;
  beforeEach(() => { db = initDb(':memory:'); });
  afterEach(() => db.close());

  it('seeds the twelve groups', () => {
    const rows = db
      .prepare('SELECT name FROM taxonomy_group ORDER BY sort_order')
      .all() as Array<{ name: string }>;
    expect(rows).toHaveLength(12);
    expect(rows.map((r) => r.name)).toEqual(SEED_GROUPS.map((g) => g.name));
  });

  it('maps every seeded style exactly once', () => {
    const declared = SEED_GROUPS.flatMap((g) => g.styles);
    expect(new Set(declared).size, 'a style is listed in two groups').toBe(declared.length);

    const row = db.prepare('SELECT COUNT(*) AS n FROM taxonomy_style').get() as { n: number };
    expect(row.n).toBe(declared.length);
  });

  it('maps the coarse Discogs genres', () => {
    const row = db.prepare('SELECT COUNT(*) AS n FROM taxonomy_genre').get() as { n: number };
    expect(row.n).toBe(13);
  });

  it('is idempotent — seeding twice does not duplicate', () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM taxonomy_group').get() as { n: number };
    migrate(db);
    const after = db.prepare('SELECT COUNT(*) AS n FROM taxonomy_group').get() as { n: number };
    expect(after.n).toBe(before.n);
  });

  it('round-trips settings', () => {
    expect(getSetting(db, 'hide_group_below', 'x')).toBe('3');
    setSetting(db, 'hide_group_below', '5');
    expect(getSetting(db, 'hide_group_below', 'x')).toBe('5');
    expect(getSetting(db, 'nope', 'fallback')).toBe('fallback');
  });
});
