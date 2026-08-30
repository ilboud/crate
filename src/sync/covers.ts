import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Mirrors cover art to local disk. The collection is near-static, so images
 * are fetched once and served off the NAS: cover flow then stays smooth over
 * wifi, never hits the Discogs CDN, and keeps working when Discogs is down.
 */

export interface CoverPaths {
  coverPath: string | null;
  thumbPath: string | null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function download(
  url: string,
  dest: string,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  try {
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': 'DiscogsCollectionApp/0.1' },
    });
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) return false;
    await writeFile(dest, buf);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetch full and thumb images for a release. Missing art is not an error —
 * the UI falls back to a generated placeholder — so this resolves with nulls
 * rather than throwing.
 */
export async function mirrorCovers(
  releaseId: number,
  coverUrl: string | undefined,
  thumbUrl: string | undefined,
  coversDir: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CoverPaths> {
  await mkdir(coversDir, { recursive: true });

  const coverFile = `${releaseId}-full.jpg`;
  const thumbFile = `${releaseId}-thumb.jpg`;
  const coverDest = join(coversDir, coverFile);
  const thumbDest = join(coversDir, thumbFile);

  let coverPath: string | null = null;
  let thumbPath: string | null = null;

  if (await exists(coverDest)) {
    coverPath = coverFile;
  } else if (coverUrl && (await download(coverUrl, coverDest, fetchImpl))) {
    coverPath = coverFile;
  }

  if (await exists(thumbDest)) {
    thumbPath = thumbFile;
  } else if (thumbUrl && (await download(thumbUrl, thumbDest, fetchImpl))) {
    thumbPath = thumbFile;
  }

  return { coverPath, thumbPath };
}
