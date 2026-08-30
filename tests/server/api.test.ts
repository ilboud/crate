import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, type Db } from '../../src/db/index.js';
import { createApp } from '../../src/server/app.js';
import { storeRelease } from '../../src/sync/sync.js';
import { reassignAll } from '../../src/sync/taxonomy.js';
import { rebuildSimilar } from '../../src/sync/similar.js';
import type { ReleaseDetail } from '../../src/shared/types.js';
import type { Express } from 'express';

function release(
  id: number,
  title: string,
  artist: string,
  styles: string[],
  genres: string[],
  tracks: Array<[string, string]>,
  year = 1959,
): ReleaseDetail {
  return {
    id, title, year,
    artists: [{ id: 900 + id, name: artist }],
    labels: [{ id: 1, name: 'Columbia', catno: `CL ${id}` }],
    formats: [{ name: 'Vinyl', qty: '2', descriptions: ['LP', 'Album'] }],
    genres, styles,
    tracklist: tracks.map(([position, title]) => ({ position, title, duration: '5:00' })),
  };
}

describe('collection API', () => {
  let db: Db;
  let app: Express;
  let coversDir: string;

  beforeEach(() => {
    db = initDb(':memory:');
    coversDir = mkdtempSync(join(tmpdir(), 'covers-api-'));

    storeRelease(db, release(1, 'Kind Of Blue', 'Miles Davis', ['Modal'], ['Jazz'],
      [['A1', 'So What'], ['A2', 'Freddie Freeloader'], ['B1', 'Blue In Green']]),
      { coverPath: '1-full.jpg', thumbPath: '1-thumb.jpg' });
    storeRelease(db, release(2, 'Bitches Brew', 'Miles Davis', ['Fusion'], ['Jazz'],
      [['A', 'Pharaoh\'s Dance'], ['B', 'Bitches Brew'], ['C1', 'Spanish Key']], 1970),
      { coverPath: null, thumbPath: null });
    storeRelease(db, release(3, 'Time Out', 'The Dave Brubeck Quartet', ['Cool Jazz'], ['Jazz'],
      [['A1', 'Blue Rondo A La Turk'], ['A2', 'Take Five']]),
      { coverPath: null, thumbPath: null });
    // A different genre, and a song title that also exists on release 1.
    storeRelease(db, release(4, 'Portrait In Jazz', 'Bill Evans Trio', ['Cool Jazz'], ['Jazz'],
      [['A1', 'Blue In Green'], ['A2', 'Autumn Leaves']]),
      { coverPath: null, thumbPath: null });

    db.prepare('INSERT INTO collection_item (instance_id, release_id, folder_id, date_added) VALUES (?,?,?,?)')
      .run(101, 1, 1, '2026-01-01T00:00:00-00:00');
    db.prepare('INSERT INTO collection_item (instance_id, release_id, folder_id, date_added) VALUES (?,?,?,?)')
      .run(102, 1, 1, '2026-02-01T00:00:00-00:00');
    for (const [inst, rel] of [[103, 2], [104, 3], [105, 4]]) {
      db.prepare('INSERT INTO collection_item (instance_id, release_id, folder_id, date_added) VALUES (?,?,?,?)')
        .run(inst, rel, 1, '2026-01-15T00:00:00-00:00');
    }

    reassignAll(db);
    rebuildSimilar(db);
    app = createApp(db, { coversDir });
  });

  afterEach(() => {
    db.close();
    rmSync(coversDir, { recursive: true, force: true });
  });

  it('reports health', async () => {
    const res = await request(app).get('/healthz').expect(200);
    expect(res.body.ok).toBe(true);
  });

  it('summarises the collection', async () => {
    const res = await request(app).get('/api/stats').expect(200);
    expect(res.body.releases).toBe(4);
    expect(res.body.copies).toBe(5);
    expect(res.body.tracks).toBe(10);
  });

  it('lists groups with counts and hides small ones', async () => {
    const res = await request(app).get('/api/groups').expect(200);
    const jazz = res.body.find((g: { name: string }) => g.name === 'Jazz');
    expect(jazz.count).toBe(4);
    expect(jazz.hidden).toBe(false);
    // Empty groups fall below the threshold of 3 and are hidden from nav.
    const pop = res.body.find((g: { name: string }) => g.name === 'Pop');
    expect(pop.count).toBe(0);
    expect(pop.hidden).toBe(true);
  });

  it('browses by group', async () => {
    const res = await request(app).get('/api/browse?group=Jazz').expect(200);
    expect(res.body).toHaveLength(4);
    expect(res.body[0]).toHaveProperty('artist');
    expect(res.body[0]).toHaveProperty('thumb_path');
  });

  it('browses by style', async () => {
    const res = await request(app).get('/api/browse?style=Cool%20Jazz').expect(200);
    expect(res.body.map((a: { title: string }) => a.title).sort())
      .toEqual(['Portrait In Jazz', 'Time Out']);
  });

  it('sorts by year descending', async () => {
    const res = await request(app).get('/api/browse?sort=year').expect(200);
    expect(res.body[0].title).toBe('Bitches Brew');
  });

  it('reports how many copies of a release are owned', async () => {
    const res = await request(app).get('/api/browse?group=Jazz').expect(200);
    const kob = res.body.find((a: { title: string }) => a.title === 'Kind Of Blue');
    expect(kob.copies).toBe(2);
  });

  it('returns an album with tracks grouped by disc and side', async () => {
    const res = await request(app).get('/api/albums/2').expect(200);
    expect(res.body.title).toBe('Bitches Brew');

    const discs = res.body.discs;
    expect(discs).toHaveLength(2);
    expect(discs[0].disc).toBe(1);
    expect(discs[0].sides.map((s: { side: string }) => s.side)).toEqual(['A', 'B']);
    // A whole-side track carries no index.
    expect(discs[0].sides[0].tracks[0].title).toBe("Pharaoh's Dance");
    expect(discs[0].sides[0].tracks[0].index_on_side).toBeNull();
    expect(discs[1].disc).toBe(2);
    expect(discs[1].sides[0].side).toBe('C');
  });

  it('includes label, catalogue number and formats on an album', async () => {
    const res = await request(app).get('/api/albums/1').expect(200);
    expect(res.body.labels[0]).toMatchObject({ name: 'Columbia', catno: 'CL 1' });
    expect(res.body.formats[0]).toMatchObject({ name: 'Vinyl', qty: 2 });
    expect(res.body.formats[0].descriptions).toEqual(['LP', 'Album']);
  });

  it('splits recommendations into other-artist and same-artist rails', async () => {
    const res = await request(app).get('/api/albums/1').expect(200);
    const alsoLike = res.body.similar.map((s: { title: string }) => s.title);
    const byArtist = res.body.moreByArtist.map((s: { title: string }) => s.title);

    expect(byArtist).toContain('Bitches Brew');
    expect(alsoLike).not.toContain('Bitches Brew');
    expect(res.body.similar[0]).toHaveProperty('reason');
  });

  it('404s an unknown album', async () => {
    await request(app).get('/api/albums/9999').expect(404);
  });

  it('rejects a non-numeric album id', async () => {
    await request(app).get('/api/albums/abc').expect(400);
  });

  it('finds every album containing a song', async () => {
    const res = await request(app).get('/api/search?q=Blue+In+Green').expect(200);
    const albums = res.body.tracks.map((t: { album: string }) => t.album).sort();
    expect(albums).toEqual(['Kind Of Blue', 'Portrait In Jazz']);
    expect(res.body.tracks[0]).toHaveProperty('side');
    expect(res.body.tracks[0]).toHaveProperty('disc');
  });

  it('searches albums and artists too', async () => {
    const res = await request(app).get('/api/search?q=Miles').expect(200);
    expect(res.body.artists.map((a: { name: string }) => a.name)).toContain('Miles Davis');
  });

  it('matches a partial word as you type', async () => {
    const res = await request(app).get('/api/search?q=Freddie').expect(200);
    expect(res.body.tracks.length).toBeGreaterThan(0);
  });

  it('survives punctuation that would break a raw FTS query', async () => {
    for (const q of ['"', '*', 'blue"', '((', 'a AND']) {
      await request(app).get(`/api/search?q=${encodeURIComponent(q)}`).expect(200);
    }
  });

  it('returns empty results for a blank query', async () => {
    const res = await request(app).get('/api/search?q=').expect(200);
    expect(res.body).toEqual({ albums: [], tracks: [], artists: [] });
  });
});

describe('admin taxonomy API', () => {
  let db: Db;
  let app: Express;
  let coversDir: string;

  beforeEach(() => {
    db = initDb(':memory:');
    coversDir = mkdtempSync(join(tmpdir(), 'covers-admin-'));
    storeRelease(db, release(1, 'Kind Of Blue', 'Miles Davis', ['Modal'], ['Jazz'], [['A1', 'So What']]),
      { coverPath: null, thumbPath: null });
    reassignAll(db);
    app = createApp(db, { coversDir });
  });
  afterEach(() => {
    db.close();
    rmSync(coversDir, { recursive: true, force: true });
  });

  const groupOf = (id: number) =>
    (db.prepare('SELECT primary_group AS g FROM release WHERE id = ?').get(id) as { g: string }).g;

  it('returns the taxonomy with per-style counts', async () => {
    const res = await request(app).get('/api/admin/taxonomy').expect(200);
    expect(res.body.groups).toHaveLength(12);
    expect(res.body.hideGroupBelow).toBe(3);
    expect(res.body.unassigned).toEqual([]);
  });

  it('moving a style re-derives affected albums immediately', async () => {
    expect(groupOf(1)).toBe('Jazz');
    const pop = db.prepare("SELECT id FROM taxonomy_group WHERE name = 'Pop'").get() as { id: number };

    await request(app)
      .put('/api/admin/taxonomy/style')
      .send({ style: 'Modal', group_id: pop.id })
      .expect(200);

    expect(groupOf(1)).toBe('Pop');
  });

  it('creates, renames and deletes a group', async () => {
    const created = await request(app)
      .post('/api/admin/taxonomy/group')
      .send({ name: 'Spiritual Jazz' })
      .expect(201);
    const id = created.body.id;

    await request(app).patch(`/api/admin/taxonomy/group/${id}`).send({ name: 'Deep Jazz' }).expect(200);
    const after = db.prepare('SELECT name FROM taxonomy_group WHERE id = ?').get(id) as { name: string };
    expect(after.name).toBe('Deep Jazz');

    await request(app).delete(`/api/admin/taxonomy/group/${id}`).expect(200);
    expect(db.prepare('SELECT id FROM taxonomy_group WHERE id = ?').get(id)).toBeUndefined();
  });

  it('rejects a duplicate group name', async () => {
    await request(app).post('/api/admin/taxonomy/group').send({ name: 'Jazz' }).expect(409);
  });

  it('rejects a group with no name', async () => {
    await request(app).post('/api/admin/taxonomy/group').send({}).expect(400);
  });

  it('sets and clears a per-album override', async () => {
    const pop = db.prepare("SELECT id FROM taxonomy_group WHERE name = 'Pop'").get() as { id: number };

    await request(app).put('/api/admin/override/1').send({ group_id: pop.id, note: 'mine' }).expect(200);
    expect(groupOf(1)).toBe('Pop');

    await request(app).put('/api/admin/override/1').send({ group_id: null }).expect(200);
    expect(groupOf(1)).toBe('Jazz');
  });

  it('404s an override for an unknown release', async () => {
    await request(app).put('/api/admin/override/9999').send({ group_id: 1 }).expect(404);
  });

  it('updates the hide threshold', async () => {
    await request(app).put('/api/admin/settings/hide-group-below').send({ value: 10 }).expect(200);
    const res = await request(app).get('/api/groups').expect(200);
    const jazz = res.body.find((g: { name: string }) => g.name === 'Jazz');
    expect(jazz.hidden).toBe(true);
  });

  it('rejects a negative threshold', async () => {
    await request(app).put('/api/admin/settings/hide-group-below').send({ value: -1 }).expect(400);
  });

  it('exports a portable taxonomy', async () => {
    const res = await request(app).get('/api/admin/taxonomy/export').expect(200);
    expect(res.body.version).toBe(1);
    const jazz = res.body.groups.find((g: { name: string }) => g.name === 'Jazz');
    expect(jazz.styles).toContain('Modal');
    expect(jazz.genres).toContain('Jazz');
  });
});

describe('chat status', () => {
  it('reports disabled when no key is configured', async () => {
    const db = initDb(':memory:');
    const coversDir = mkdtempSync(join(tmpdir(), 'covers-chat-'));
    const app = createApp(db, { coversDir, chat: { backend: undefined } });

    const res = await request(app).get('/api/chat/status').expect(200);
    expect(res.body).toHaveProperty('enabled');
    expect(res.body.localTools).toBe(4);

    db.close();
    rmSync(coversDir, { recursive: true, force: true });
  });
});
