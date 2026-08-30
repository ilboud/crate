import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, type Db } from '../../src/db/index.js';
import { runSync } from '../../src/sync/sync.js';
import type { CollectionItem, ReleaseDetail } from '../../src/shared/types.js';

/** A stand-in Discogs API whose failures and contents the test controls. */
class FakeClient {
  failFor = new Set<number>();
  releaseCalls: number[] = [];
  constructor(
    private items: CollectionItem[],
    private details: Map<number, ReleaseDetail>,
  ) {}
  async getCollection(): Promise<CollectionItem[]> {
    return this.items;
  }
  async getRelease(id: number): Promise<ReleaseDetail> {
    this.releaseCalls.push(id);
    if (this.failFor.has(id)) throw new Error(`boom ${id}`);
    const d = this.details.get(id);
    if (!d) throw new Error(`no fixture for ${id}`);
    return d;
  }
}

function item(releaseId: number, instanceId: number): CollectionItem {
  return {
    id: releaseId,
    instance_id: instanceId,
    folder_id: 1,
    date_added: '2026-01-01T00:00:00-00:00',
    basic_information: {
      id: releaseId,
      title: `Album ${releaseId}`,
      year: 1970,
      artists: [{ id: 900 + releaseId, name: `Artist ${releaseId}` }],
      labels: [{ id: 1, name: 'Columbia', catno: `CL ${releaseId}` }],
      genres: ['Jazz'],
      styles: ['Modal'],
      cover_image: undefined,
      thumb: undefined,
    },
  };
}

function detail(releaseId: number, tracks: Array<[string, string]>): ReleaseDetail {
  return {
    id: releaseId,
    title: `Album ${releaseId}`,
    year: 1970,
    artists: [{ id: 900 + releaseId, name: `Artist ${releaseId}` }],
    labels: [{ id: 1, name: 'Columbia', catno: `CL ${releaseId}` }],
    genres: ['Jazz'],
    styles: ['Modal'],
    formats: [{ name: 'Vinyl', qty: '2', descriptions: ['LP', 'Album'] }],
    tracklist: tracks.map(([position, title]) => ({ position, title, duration: '3:00' })),
  };
}

describe('runSync', () => {
  let db: Db;
  let coversDir: string;
  let client: FakeClient;

  beforeEach(() => {
    db = initDb(':memory:');
    coversDir = mkdtempSync(join(tmpdir(), 'covers-'));
    client = new FakeClient(
      [item(1, 101), item(2, 102)],
      new Map([
        [1, detail(1, [['A', 'Whole Side A'], ['B1', 'Side B First'], ['B2', 'Side B Second']])],
        [2, detail(2, [['A1', 'Track One'], ['A2', 'Track Two']])],
      ]),
    );
  });
  afterEach(() => {
    db.close();
    rmSync(coversDir, { recursive: true, force: true });
  });

  const sync = (force = false) =>
    runSync(db, { client, coversDir }, { username: 'tester', force });

  it('stores releases, tracks and instances on a fresh sync', async () => {
    const res = await sync();
    expect(res.added).toBe(2);
    expect(res.failed).toEqual([]);

    const releases = db.prepare('SELECT COUNT(*) AS n FROM release').get() as { n: number };
    const tracks = db.prepare('SELECT COUNT(*) AS n FROM track').get() as { n: number };
    const items = db.prepare('SELECT COUNT(*) AS n FROM collection_item').get() as { n: number };
    expect(releases.n).toBe(2);
    expect(tracks.n).toBe(5);
    expect(items.n).toBe(2);
  });

  it('parses disc and side onto stored tracks', async () => {
    await sync();
    const rows = db
      .prepare('SELECT title, disc, side, index_on_side FROM track WHERE release_id = 1 ORDER BY seq')
      .all() as Array<{ title: string; disc: number; side: string; index_on_side: number | null }>;
    expect(rows[0]).toMatchObject({ title: 'Whole Side A', disc: 1, side: 'A', index_on_side: null });
    expect(rows[1]).toMatchObject({ title: 'Side B First', disc: 1, side: 'B', index_on_side: 1 });
  });

  it('is incremental — a second run refetches nothing', async () => {
    await sync();
    const first = client.releaseCalls.length;
    const res = await sync();
    expect(client.releaseCalls.length).toBe(first);
    expect(res.added).toBe(0);
    expect(res.unchanged).toBe(2);
  });

  it('refetches everything when forced', async () => {
    await sync();
    const before = client.releaseCalls.length;
    await sync(true);
    expect(client.releaseCalls.length).toBe(before + 2);
  });

  it('is idempotent — re-syncing does not duplicate tracks', async () => {
    await sync();
    await sync(true);
    const tracks = db.prepare('SELECT COUNT(*) AS n FROM track').get() as { n: number };
    const fts = db.prepare('SELECT COUNT(*) AS n FROM track_fts').get() as { n: number };
    expect(tracks.n).toBe(5);
    expect(fts.n).toBe(5);
  });

  it('isolates a failing release without losing the others', async () => {
    client.failFor.add(2);
    const res = await sync();

    expect(res.failed).toEqual([2]);
    expect(res.added).toBe(1);
    const releases = db.prepare('SELECT id FROM release').all() as Array<{ id: number }>;
    expect(releases.map((r) => r.id)).toEqual([1]);
  });

  it('records failures on the sync run for retry', async () => {
    client.failFor.add(2);
    await sync();
    const run = db
      .prepare('SELECT ok_count, failed_ids, finished_at FROM sync_run ORDER BY id DESC LIMIT 1')
      .get() as { ok_count: number; failed_ids: string; finished_at: string };
    expect(run.ok_count).toBe(1);
    expect(JSON.parse(run.failed_ids)).toEqual([2]);
    expect(run.finished_at).toBeTruthy();
  });

  it('retries a previously failed release on the next run', async () => {
    client.failFor.add(2);
    await sync();
    client.failFor.clear();
    const res = await sync();
    expect(res.added).toBe(1);
    expect(res.failed).toEqual([]);
    const n = db.prepare('SELECT COUNT(*) AS n FROM release').get() as { n: number };
    expect(n.n).toBe(2);
  });

  it('prunes releases removed from the collection', async () => {
    await sync();
    client = new FakeClient([item(1, 101)], new Map([[1, detail(1, [['A', 'Whole Side A']])]]));
    const res = await runSync(db, { client, coversDir }, { username: 'tester' });

    expect(res.removed).toBe(1);
    const ids = (db.prepare('SELECT id FROM release').all() as Array<{ id: number }>).map((r) => r.id);
    expect(ids).toEqual([1]);
    // Cascade must clear the orphaned tracks too.
    const orphans = db.prepare('SELECT COUNT(*) AS n FROM track WHERE release_id = 2').get() as { n: number };
    expect(orphans.n).toBe(0);
  });

  it('stores two instances of a release owned twice, as one release', async () => {
    client = new FakeClient(
      [item(1, 101), item(1, 102)],
      new Map([[1, detail(1, [['A', 'X']])]]),
    );
    const res = await runSync(db, { client, coversDir }, { username: 'tester' });

    expect(res.items).toBe(2);
    expect(res.added).toBe(1);
    const releases = db.prepare('SELECT COUNT(*) AS n FROM release').get() as { n: number };
    const instances = db.prepare('SELECT COUNT(*) AS n FROM collection_item').get() as { n: number };
    expect(releases.n).toBe(1);
    expect(instances.n).toBe(2);
  });

  it('assigns groups and builds recommendations as part of the run', async () => {
    await sync();
    const group = db.prepare('SELECT primary_group AS g FROM release WHERE id = 1').get() as { g: string };
    expect(group.g).toBe('Jazz');
    const sim = db.prepare('SELECT COUNT(*) AS n FROM similar').get() as { n: number };
    expect(sim.n).toBeGreaterThan(0);
  });

  it('skips tracklist headings, keeping only playable tracks', async () => {
    client = new FakeClient(
      [item(1, 101)],
      new Map([[1, {
        ...detail(1, []),
        tracklist: [
          { position: '', title: 'Part One', type_: 'heading' },
          { position: 'A1', title: 'Real Track', type_: 'track', duration: '3:00' },
        ],
      }]]),
    );
    await runSync(db, { client, coversDir }, { username: 'tester' });
    const rows = db.prepare('SELECT title FROM track').all() as Array<{ title: string }>;
    expect(rows.map((r) => r.title)).toEqual(['Real Track']);
  });
});
