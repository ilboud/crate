import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb, type Db } from '../../src/db/index.js';
import {
  assignGroup,
  loadTaxonomy,
  reassignAll,
  unassignedStyles,
} from '../../src/sync/taxonomy.js';
import type { BasicInformation } from '../../src/shared/types.js';
import fixture from '../fixtures/collection.json' with { type: 'json' };

/** 245 collection items, but 244 distinct releases — one record is owned twice. */
const items = fixture as unknown as BasicInformation[];
const collection = [...new Map(items.map((r) => [r.id, r])).values()];

function seedReleases(db: Db, releases: BasicInformation[]): void {
  const ins = db.prepare('INSERT INTO release (id, title, year, raw_json) VALUES (?,?,?,?)');
  const insStyle = db.prepare('INSERT OR IGNORE INTO release_style (release_id, style) VALUES (?,?)');
  db.transaction(() => {
    for (const r of releases) {
      ins.run(r.id, r.title, r.year ?? null, JSON.stringify(r));
      for (const s of r.styles ?? []) insStyle.run(r.id, s);
    }
  })();
}

function byTitle(fragment: string): BasicInformation {
  const hit = collection.find((r) => r.title.toLowerCase().includes(fragment.toLowerCase()));
  if (!hit) throw new Error(`fixture missing a title containing "${fragment}"`);
  return hit;
}

describe('assignGroup', () => {
  let db: Db;
  beforeEach(() => { db = initDb(':memory:'); });
  afterEach(() => db.close());

  it('assigns by style majority', () => {
    const tax = loadTaxonomy(db);
    const r = { id: 1, title: 'x', styles: ['Modal', 'Hard Bop'], genres: ['Jazz'] };
    expect(assignGroup(r, tax)).toEqual({ group: 'Jazz', how: 'style-majority' });
  });

  it('breaks style ties using the coarse Discogs genre', () => {
    const tax = loadTaxonomy(db);
    // Folk Rock -> Rock, Rhythm & Blues -> Soul / Funk. One each; genre decides.
    const r = {
      id: 2, title: 'Blonde On Blonde',
      styles: ['Folk Rock', 'Rhythm & Blues'], genres: ['Rock'],
    };
    expect(assignGroup(r, tax)).toEqual({ group: 'Rock', how: 'genre-tiebreak' });
  });

  it('falls back to genre when the release carries no styles', () => {
    const tax = loadTaxonomy(db);
    const r = { id: 3, title: 'x', styles: [], genres: ['Funk / Soul'] };
    expect(assignGroup(r, tax)).toEqual({ group: 'Soul / Funk', how: 'genre-only' });
  });

  it('falls back to precedence when genre cannot break the tie', () => {
    const tax = loadTaxonomy(db);
    // Both contenders endorsed by genres -> precedence picks the more specific.
    const r = {
      id: 4, title: 'x',
      styles: ['Soundtrack', 'Cool Jazz'], genres: ['Jazz', 'Stage & Screen'],
    };
    const got = assignGroup(r, tax);
    expect(got.how).toBe('precedence');
    expect(got.group).toBe('Jazz');
  });

  it('lets a manual override beat every rule', () => {
    const tax = loadTaxonomy(db);
    tax.overrides.set(5, 'Pop');
    const r = { id: 5, title: 'x', styles: ['Modal', 'Hard Bop'], genres: ['Jazz'] };
    expect(assignGroup(r, tax)).toEqual({ group: 'Pop', how: 'override' });
  });

  it('returns Unsorted when nothing matches', () => {
    const tax = loadTaxonomy(db);
    const r = { id: 6, title: 'x', styles: ['Nonexistent Style'], genres: ['Nonexistent Genre'] };
    expect(assignGroup(r, tax)).toEqual({ group: 'Unsorted', how: 'unsorted' });
  });
});

describe('reassignAll over the real collection', () => {
  let db: Db;
  beforeEach(() => {
    db = initDb(':memory:');
    seedReleases(db, collection);
  });
  afterEach(() => db.close());

  it('assigns every distinct release, counts summing to the release total', () => {
    expect(items).toHaveLength(245);
    expect(collection).toHaveLength(244);

    const counts = reassignAll(db);
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    expect(total).toBe(244);

    const nulls = db
      .prepare('SELECT COUNT(*) AS n FROM release WHERE primary_group IS NULL')
      .get() as { n: number };
    expect(nulls.n).toBe(0);
  });

  it('leaves nothing Unsorted', () => {
    reassignAll(db);
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM release WHERE primary_group = 'Unsorted'")
      .get() as { n: number };
    expect(row.n).toBe(0);
  });

  it('files known straddlers correctly', () => {
    reassignAll(db);
    const groupOf = (fragment: string) => {
      const r = byTitle(fragment);
      const row = db
        .prepare('SELECT primary_group AS g FROM release WHERE id = ?')
        .get(r.id) as { g: string };
      return row.g;
    };
    // These four are wrong without the genre tie-break tier.
    expect(groupOf('Blonde On Blonde')).toBe('Rock');
    expect(groupOf('De-Loused In The Comatorium')).toBe('Rock');
    expect(groupOf('Live At Fillmore West')).toBe('Soul / Funk');
    expect(groupOf('Kind Of Blue')).toBe('Jazz');
  });

  it('produces the expected group distribution', () => {
    const counts = reassignAll(db);
    expect(counts.get('Jazz')).toBe(62);
    expect(counts.get('Rock')).toBe(54);
    // 37 minus the duplicated Bar-Kays copy, which is one release not two.
    expect(counts.get('Soul / Funk')).toBe(36);
    expect(counts.get('Hip-Hop / R&B')).toBe(20);
    expect(counts.size).toBe(12);
  });

  it('honours an override on re-assignment', () => {
    const kob = byTitle('Kind Of Blue');
    const pop = db.prepare("SELECT id FROM taxonomy_group WHERE name = 'Pop'").get() as { id: number };
    db.prepare('INSERT INTO release_override (release_id, group_id, note) VALUES (?,?,?)')
      .run(kob.id, pop.id, 'test');

    reassignAll(db);
    const row = db
      .prepare('SELECT primary_group AS g, assign_method AS m FROM release WHERE id = ?')
      .get(kob.id) as { g: string; m: string };
    expect(row.g).toBe('Pop');
    expect(row.m).toBe('override');
  });

  it('reports no unassigned styles for the seeded taxonomy', () => {
    expect(unassignedStyles(db)).toEqual([]);
  });

  it('reports a style the taxonomy does not claim', () => {
    db.prepare('INSERT INTO release_style (release_id, style) VALUES (?,?)')
      .run(collection[0]!.id, 'Totally New Style');
    const missing = unassignedStyles(db);
    expect(missing.map((m) => m.style)).toContain('Totally New Style');
  });

  it('re-derives groups after a style is moved to another group', () => {
    reassignAll(db);
    const kob = byTitle('Kind Of Blue');
    const before = db.prepare('SELECT primary_group AS g FROM release WHERE id = ?').get(kob.id) as { g: string };
    expect(before.g).toBe('Jazz');

    const pop = db.prepare("SELECT id FROM taxonomy_group WHERE name = 'Pop'").get() as { id: number };
    db.prepare('UPDATE taxonomy_style SET group_id = ? WHERE style = ?').run(pop.id, 'Modal');

    reassignAll(db);
    const after = db.prepare('SELECT primary_group AS g FROM release WHERE id = ?').get(kob.id) as { g: string };
    expect(after.g).toBe('Pop');
  });
});
