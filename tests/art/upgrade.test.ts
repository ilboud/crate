import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, type Db } from '../../src/db/index.js';
import { storeRelease } from '../../src/sync/sync.js';
import { upgradeArt, imageSize, barcodesOf } from '../../src/art/upgrade.js';
import type { Candidate } from '../../src/art/match.js';
import type { ReleaseDetail } from '../../src/shared/types.js';

/** A minimal valid JPEG header declaring the given dimensions. */
function fakeJpeg(width: number, height: number): Buffer {
  const b = Buffer.alloc(20);
  b[0] = 0xff; b[1] = 0xd8;          // SOI
  b[2] = 0xff; b[3] = 0xc0;          // SOF0
  b.writeUInt16BE(11, 4);            // segment length
  b[6] = 8;                          // precision
  b.writeUInt16BE(height, 7);
  b.writeUInt16BE(width, 9);
  return b;
}

function release(id: number, title: string, artist: string, barcode?: string): ReleaseDetail {
  return {
    id, title, year: 1970,
    artists: [{ id: 900 + id, name: artist }],
    labels: [{ id: 1, name: 'Columbia', catno: `CL ${id}` }],
    genres: ['Jazz'], styles: ['Modal'],
    formats: [{ name: 'Vinyl', qty: '1', descriptions: ['LP'] }],
    tracklist: [{ position: 'A1', title: 'A Track', duration: '3:00' }],
    ...(barcode ? { identifiers: [{ type: 'Barcode', value: barcode }] } : {}),
  } as ReleaseDetail;
}

describe('imageSize', () => {
  it('reads JPEG dimensions from the frame header', () => {
    expect(imageSize(fakeJpeg(1200, 1200))).toEqual({ width: 1200, height: 1200 });
  });

  it('reads PNG dimensions', () => {
    const b = Buffer.alloc(26);
    b.writeUInt32BE(0x89504e47, 0);
    b.writeUInt32BE(640, 16);
    b.writeUInt32BE(480, 20);
    expect(imageSize(b)).toEqual({ width: 640, height: 480 });
  });

  it('returns null for something that is not an image', () => {
    expect(imageSize(Buffer.from('<html>not an image</html>'))).toBeNull();
  });
});

describe('barcodesOf', () => {
  it('pulls barcode identifiers out of the stored release', () => {
    const raw = JSON.stringify({
      identifiers: [
        { type: 'Barcode', value: '0 91693-2004-1 9' },
        { type: 'Matrix / Runout', value: 'XLP-1234' },
      ],
    });
    expect(barcodesOf(raw)).toEqual(['0 91693-2004-1 9']);
  });

  it('survives unparseable json', () => {
    expect(barcodesOf('not json')).toEqual([]);
  });
});

describe('upgradeArt', () => {
  let db: Db;
  let coversDir: string;

  beforeEach(() => {
    db = initDb(':memory:');
    coversDir = mkdtempSync(join(tmpdir(), 'art-'));
    storeRelease(db, release(1, 'The Low End Theory', 'A Tribe Called Quest'),
      { coverPath: '1-full.jpg', thumbPath: '1-thumb.jpg' });
    storeRelease(db, release(2, 'Breaking Atoms', 'Main Source', '0 91693-2004-1 9'),
      { coverPath: '2-full.jpg', thumbPath: '2-thumb.jpg' });
  });
  afterEach(() => {
    db.close();
    rmSync(coversDir, { recursive: true, force: true });
  });

  const hiOf = (id: number) =>
    db.prepare('SELECT hi_path, art_source FROM release WHERE id = ?').get(id) as
      { hi_path: string | null; art_source: string | null };

  const sources = (over: Partial<Parameters<typeof upgradeArt>[1]> = {}) => ({
    findByBarcode: async () => null,
    searchItunes: async () => [] as Candidate[],
    fetchImage: async () => fakeJpeg(1200, 1200),
    ...over,
  });

  it('keeps the Discogs art when the only candidate is the wrong album', async () => {
    const res = await upgradeArt(db, sources({
      // The real failure: iTunes offers a different ATCQ record.
      searchItunes: async () => [{
        artist: 'A Tribe Called Quest',
        title: 'We got it from Here... Thank You 4 Your service',
        imageUrl: 'https://example.test/wrong.jpg',
        source: 'itunes' as const,
      }],
    }), { coversDir });

    expect(res.upgraded).toBe(0);
    expect(hiOf(1).hi_path).toBeNull();
    expect(res.rejections.some((r) => r.reason.includes('title'))).toBe(true);
  });

  it('accepts and stores a verified match', async () => {
    const res = await upgradeArt(db, sources({
      searchItunes: async (_a: string, title: string) => [{
        artist: title.includes('Low End') ? 'A Tribe Called Quest' : 'Main Source',
        title,
        imageUrl: 'https://example.test/right.jpg',
        source: 'itunes' as const,
      }],
    }), { coversDir });

    expect(res.upgraded).toBe(2);
    expect(hiOf(1).hi_path).toBe('1-hi.jpg');
    expect(hiOf(1).art_source).toBe('itunes');
    expect(existsSync(join(coversDir, '1-hi.jpg'))).toBe(true);
  });

  it('prefers a barcode match and skips the fuzzy path entirely', async () => {
    let itunesCalls = 0;
    const res = await upgradeArt(db, sources({
      findByBarcode: async (barcode: string) =>
        barcode.includes('91693')
          ? { artist: 'Anything', title: 'Anything', imageUrl: 'https://example.test/caa.jpg',
              source: 'caa' as const, exact: true }
          : null,
      searchItunes: async () => { itunesCalls++; return []; },
    }), { coversDir });

    expect(hiOf(2).art_source).toBe('caa');
    expect(res.bySource.caa).toBe(1);
    // Release 1 has no barcode, so it still falls through to iTunes.
    expect(itunesCalls).toBe(1);
  });

  it('rejects a candidate that is not actually larger than what we have', async () => {
    const res = await upgradeArt(db, sources({
      searchItunes: async (_a: string, title: string) => [{
        artist: 'A Tribe Called Quest', title,
        imageUrl: 'https://example.test/small.jpg', source: 'itunes' as const,
      }],
      fetchImage: async () => fakeJpeg(500, 500),
    }), { coversDir });

    expect(res.upgraded).toBe(0);
    expect(res.rejections.some((r) => r.reason.includes('not an upgrade'))).toBe(true);
  });

  it('is incremental — a second run rechecks nothing', async () => {
    let calls = 0;
    const s = sources({ searchItunes: async () => { calls++; return []; } });
    await upgradeArt(db, s, { coversDir });
    const first = calls;
    await upgradeArt(db, s, { coversDir });
    expect(calls).toBe(first);
  });

  it('retry re-examines only records with no upgraded art', async () => {
    let seen: string[] = [];
    const s = sources({
      searchItunes: async (_a: string, title: string) => {
        seen.push(title);
        // Only the first record gets a usable match on the initial pass.
        return title.includes('Low End')
          ? [{ artist: 'A Tribe Called Quest', title,
               imageUrl: 'https://example.test/x.jpg', source: 'itunes' as const }]
          : [];
      },
    });

    await upgradeArt(db, s, { coversDir });
    expect(hiOf(1).hi_path).toBe('1-hi.jpg');
    expect(hiOf(2).hi_path).toBeNull();

    seen = [];
    await upgradeArt(db, s, { coversDir, retry: true });
    // The already-upgraded record is left alone; only the other is retried.
    expect(seen).toEqual(['Breaking Atoms']);
  });

  it('rechecks everything when forced', async () => {
    let calls = 0;
    const s = sources({ searchItunes: async () => { calls++; return []; } });
    await upgradeArt(db, s, { coversDir });
    const first = calls;
    await upgradeArt(db, s, { coversDir, force: true });
    expect(calls).toBe(first * 2);
  });

  it('retries a download failure next run rather than marking it checked', async () => {
    let attempts = 0;
    const s = sources({
      searchItunes: async (_a: string, title: string) => [{
        artist: title.includes('Low End') ? 'A Tribe Called Quest' : 'Main Source',
        title, imageUrl: 'https://example.test/x.jpg', source: 'itunes' as const,
      }],
      fetchImage: async () => { attempts++; return null; },
    });

    const res = await upgradeArt(db, s, { coversDir });
    expect(res.failed).toBe(2);
    expect(
      (db.prepare('SELECT art_checked_at FROM release WHERE id = 1').get() as { art_checked_at: string | null })
        .art_checked_at,
    ).toBeNull();

    await upgradeArt(db, s, { coversDir });
    expect(attempts).toBe(4);
  });

  it('never overwrites the Discogs cover_path', async () => {
    await upgradeArt(db, sources({
      searchItunes: async (_a: string, title: string) => [{
        artist: title.includes('Low End') ? 'A Tribe Called Quest' : 'Main Source',
        title, imageUrl: 'https://example.test/x.jpg', source: 'itunes' as const,
      }],
    }), { coversDir });

    const row = db.prepare('SELECT cover_path FROM release WHERE id = 1').get() as { cover_path: string };
    expect(row.cover_path).toBe('1-full.jpg');
  });
});
