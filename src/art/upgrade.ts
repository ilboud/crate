import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from '../db/index.js';
import { verify, type Candidate } from './match.js';
import { Throttle, findByBarcode, searchItunes } from './sources.js';

/**
 * Upgrade cover art beyond the 600px Discogs ceiling.
 *
 * Conservative by construction: a record keeps its Discogs image unless a
 * candidate is both verified and measurably larger. Nothing is overwritten —
 * the upgrade lands in a separate file and column, so a bad result can be
 * cleared without re-syncing.
 */

export interface ArtCandidateSource {
  findByBarcode: typeof findByBarcode;
  searchItunes: typeof searchItunes;
  fetchImage: (url: string) => Promise<Buffer | null>;
}

export interface UpgradeOptions {
  coversDir: string;
  /** Re-examine records already checked. */
  force?: boolean;
  /** Minimum width to bother storing; below this the Discogs art is as good. */
  minWidth?: number;
  onProgress?: (done: number, total: number, label: string) => void;
}

export interface UpgradeResult {
  upgraded: number;
  kept: number;
  failed: number;
  bySource: Record<string, number>;
  rejections: Array<{ id: number; title: string; reason: string }>;
}

/** Read width and height from a JPEG or PNG header, without an image library. */
export function imageSize(buf: Buffer): { width: number; height: number } | null {
  // PNG: IHDR width/height are big-endian at fixed offsets.
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // JPEG: walk the segment markers to the first SOF frame header.
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1]!;
      // SOF0..SOF15, excluding the DHT/JPG/DAC markers interleaved among them.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      const len = buf.readUInt16BE(i + 2);
      if (len < 2) return null;
      i += 2 + len;
    }
  }
  return null;
}

/** Barcodes recorded on a Discogs release, most specific identifier first. */
export function barcodesOf(rawJson: string): string[] {
  try {
    const parsed = JSON.parse(rawJson) as {
      identifiers?: Array<{ type?: string; value?: string }>;
    };
    return (parsed.identifiers ?? [])
      .filter((i) => /barcode/i.test(i.type ?? '') && i.value)
      .map((i) => i.value!);
  } catch {
    return [];
  }
}

export async function upgradeArt(
  db: Db,
  sources: ArtCandidateSource,
  opts: UpgradeOptions,
): Promise<UpgradeResult> {
  const minWidth = opts.minWidth ?? 700;
  await mkdir(opts.coversDir, { recursive: true });

  const releases = db
    .prepare(
      `SELECT r.id, r.title, r.raw_json, r.hi_path, r.art_checked_at,
              (SELECT GROUP_CONCAT(a.name, ' / ')
                 FROM release_artist ra JOIN artist a ON a.id = ra.artist_id
                WHERE ra.release_id = r.id) AS artist
         FROM release r
        ORDER BY r.id`,
    )
    .all() as Array<{
      id: number; title: string; raw_json: string;
      hi_path: string | null; art_checked_at: string | null; artist: string | null;
    }>;

  const todo = releases.filter((r) => opts.force || !r.art_checked_at);

  const result: UpgradeResult = {
    upgraded: 0, kept: 0, failed: 0, bySource: {}, rejections: [],
  };

  const mbThrottle = new Throttle(1100);   // MusicBrainz: one request a second
  const itunesThrottle = new Throttle(400);

  const record = db.prepare(
    'UPDATE release SET hi_path = ?, art_source = ?, art_checked_at = ? WHERE id = ?',
  );

  for (const [i, rel] of todo.entries()) {
    opts.onProgress?.(i + 1, todo.length, rel.title);
    const target = { artist: rel.artist ?? '', title: rel.title };
    let chosen: Candidate | null = null;
    let rejection: string | null = null;

    // 1. Barcode first: it identifies the exact pressing, so no fuzzy check.
    for (const barcode of barcodesOf(rel.raw_json)) {
      await mbThrottle.wait();
      const hit = await sources.findByBarcode(barcode);
      if (hit) { chosen = hit; break; }
    }

    // 2. Otherwise iTunes, where every candidate must pass verification.
    if (!chosen) {
      await itunesThrottle.wait();
      const candidates = await sources.searchItunes(target.artist, target.title);
      for (const c of candidates) {
        const v = verify(target, c);
        if (v.ok) { chosen = c; break; }
        rejection ??= v.reason;
      }
    }

    if (!chosen) {
      result.kept += 1;
      if (rejection) result.rejections.push({ id: rel.id, title: rel.title, reason: rejection });
      record.run(rel.hi_path, null, new Date().toISOString(), rel.id);
      continue;
    }

    const buf = await sources.fetchImage(chosen.imageUrl);
    if (!buf) {
      result.failed += 1;
      // No checked_at, so a transient network failure retries next run.
      continue;
    }

    // Only keep art that is actually an improvement on the 600px Discogs image.
    const size = imageSize(buf);
    if (!size || size.width < minWidth) {
      result.kept += 1;
      result.rejections.push({
        id: rel.id,
        title: rel.title,
        reason: `candidate was ${size ? `${size.width}px` : 'unreadable'}, not an upgrade`,
      });
      record.run(rel.hi_path, null, new Date().toISOString(), rel.id);
      continue;
    }

    const file = `${rel.id}-hi.jpg`;
    await writeFile(join(opts.coversDir, file), buf);
    record.run(file, chosen.source, new Date().toISOString(), rel.id);
    result.upgraded += 1;
    result.bySource[chosen.source] = (result.bySource[chosen.source] ?? 0) + 1;
  }

  return result;
}
