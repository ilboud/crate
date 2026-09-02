import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { initDb, type Db } from '../../src/db/index.js';
import { createApp } from '../../src/server/app.js';
import { storeRelease } from '../../src/sync/sync.js';
import { SyncRunner } from '../../src/sync/runner.js';
import type { ReleaseDetail, SyncResult } from '../../src/shared/types.js';

const RESULT: SyncResult = {
  added: 0,
  removed: 1,
  unchanged: 242,
  items: 242,
  failed: [],
  durationMs: 1200,
};

function release(id: number, title: string, artist: string, catno: string, year: number): ReleaseDetail {
  return {
    id,
    title,
    year,
    artists: [{ id: 900 + (id % 100), name: artist }],
    labels: [{ id: id % 50, name: 'A Label', catno }],
    formats: [{ name: 'Vinyl', qty: '1', descriptions: ['LP', 'Album'] }],
    genres: ['Rock'],
    styles: ['Alternative Rock'],
    tracklist: [{ position: 'A1', title: 'Atlantic City', duration: '4:00' }],
  };
}

describe('library API', () => {
  let db: Db;
  let app: Express;
  let runner: SyncRunner;
  let syncImpl: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = initDb(':memory:');
    // The two Nebraska pressings, both owned.
    storeRelease(db, release(877497, 'Nebraska', 'Bruce Springsteen', 'CBS 25100', 1982), {
      coverPath: null,
      thumbPath: null,
    });
    storeRelease(db, release(24768692, 'Nebraska', 'Bruce Springsteen', '19658704921', 2022), {
      coverPath: null,
      thumbPath: null,
    });
    for (const [i, id] of [877497, 24768692].entries()) {
      db.prepare(
        'INSERT INTO collection_item (instance_id, release_id, folder_id, date_added) VALUES (?,?,?,?)',
      ).run(100 + i, id, 1, '2024-01-0' + (i + 1));
    }

    syncImpl = vi.fn(async () => RESULT);
    runner = new SyncRunner(db, {
      coversDir: 'covers',
      token: 'test-token',
      username: 'Ilboud',
      syncImpl: syncImpl as never,
    });
    app = createApp(db, { coversDir: 'covers', runner });
  });

  describe('sync', () => {
    it('reports status', async () => {
      const res = await request(app).get('/api/admin/sync').expect(200);
      expect(res.body.available).toBe(true);
      expect(res.body.running).toBe(false);
      expect(res.body.schedule).toBe('weekly');
    });

    it('starts a run and returns without waiting for it', async () => {
      const res = await request(app).post('/api/admin/sync').expect(202);
      expect(res.body.already).toBe(false);
      expect(syncImpl).toHaveBeenCalledOnce();
    });

    it('treats a press during a run as satisfied, not as an error', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const slow = new SyncRunner(db, {
        coversDir: 'covers',
        token: 't',
        username: 'Ilboud',
        syncImpl: (async () => {
          await gate;
          return RESULT;
        }) as never,
      });
      const slowApp = createApp(db, { coversDir: 'covers', runner: slow });

      await request(slowApp).post('/api/admin/sync').expect(202);
      const second = await request(slowApp).post('/api/admin/sync').expect(200);
      expect(second.body.already).toBe(true);
      release();
    });

    it('explains itself when no token reached the server', async () => {
      const bare = createApp(db, { coversDir: 'covers', runner: null });
      const res = await request(bare).get('/api/admin/sync').expect(503);
      expect(res.body.error).toContain('DISCOGS_PERSONAL_ACCESS_TOKEN');
    });

    it('stores a chosen schedule', async () => {
      const res = await request(app)
        .put('/api/admin/sync/schedule')
        .send({ schedule: 'monthly' })
        .expect(200);
      expect(res.body.schedule).toBe('monthly');
      expect((await request(app).get('/api/admin/sync')).body.schedule).toBe('monthly');
    });

    it('rejects a schedule it does not know', async () => {
      const res = await request(app)
        .put('/api/admin/sync/schedule')
        .send({ schedule: 'every-tuesday' })
        .expect(400);
      expect(res.body.error).toContain('off, daily, weekly, monthly');
    });
  });

  describe('duplicates', () => {
    it('lists the doubles it found', async () => {
      const res = await request(app).get('/api/admin/duplicates').expect(200);
      expect(res.body.groups).toHaveLength(1);
      expect(res.body.groups[0].kind).toBe('reissue');
      expect(res.body.groups[0].copies.map((c: { year: number }) => c.year)).toEqual([1982, 2022]);
    });

    it('drops a pair the user says is not a double, and can undo that', async () => {
      const ignored = await request(app)
        .post('/api/admin/duplicates/ignore')
        .send({ a: 877497, b: 24768692 })
        .expect(200);
      expect(ignored.body.groups).toEqual([]);

      const restored = await request(app)
        .post('/api/admin/duplicates/ignore')
        .send({ a: 24768692, b: 877497, ignore: false })
        .expect(200);
      expect(restored.body.groups).toHaveLength(1);
    });

    it('rejects a malformed pair', async () => {
      await request(app).post('/api/admin/duplicates/ignore').send({ a: 1 }).expect(400);
      await request(app).post('/api/admin/duplicates/ignore').send({ a: 'x', b: 2 }).expect(400);
    });

    it('accepts a release dismissing itself, which is the owned-twice case', async () => {
      await request(app)
        .post('/api/admin/duplicates/ignore')
        .send({ a: 877497, b: 877497 })
        .expect(200);
    });

    /**
     * The collection is edited on Discogs, never here. Nothing in the app may
     * add or remove a record, so the routes that would do it must not exist.
     */
    it('offers no way to change the collection', async () => {
      await request(app).post('/api/admin/duplicates/remove').send({ instanceId: 100 }).expect(404);
      await request(app).delete('/api/admin/duplicates/877497').expect(404);
    });
  });
});
