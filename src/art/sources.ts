import type { Candidate } from './match.js';

/**
 * The two art sources, behind one shape.
 *
 * Discogs caps its images at 600px, which is soft on a retina cover flow.
 * Cover Art Archive is used first when the release has a barcode, because a
 * barcode is an exact identifier and needs no fuzzy matching. iTunes is the
 * fallback: it reliably serves 1200px, but only text search, so every
 * candidate it returns has to be verified.
 */

const UA = 'DiscogsCollectionApp/0.1 (personal collection browser)';

/** Rate limiters. MusicBrainz asks for one request per second, and means it. */
export class Throttle {
  private last = 0;
  constructor(private readonly intervalMs: number) {}
  async wait(): Promise<void> {
    const gap = this.last + this.intervalMs - Date.now();
    if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    this.last = Date.now();
  }
}

async function getJson<T>(
  url: string,
  fetchImpl: typeof fetch,
): Promise<T | null> {
  try {
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ iTunes */

interface ITunesResult {
  artistName: string;
  collectionName: string;
  artworkUrl100?: string;
}

/**
 * iTunes returns a 100px URL whose path segment can be rewritten to ask for a
 * larger render. It honours up to roughly 1500px and silently clamps beyond
 * that, so asking for 1200 is safe and always satisfied.
 */
export function upscaleItunesUrl(url: string, size = 1200): string {
  return url.replace(/\/\d+x\d+bb\.jpg$/, `/${size}x${size}bb.jpg`);
}

export async function searchItunes(
  artist: string,
  title: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Candidate[]> {
  const term = `${artist} ${title}`.replace(/\s+/g, ' ').trim();
  const url =
    'https://itunes.apple.com/search?' +
    new URLSearchParams({ term, entity: 'album', limit: '5' }).toString();

  const body = await getJson<{ results?: ITunesResult[] }>(url, fetchImpl);
  return (body?.results ?? [])
    .filter((r) => r.artworkUrl100)
    .map((r) => ({
      artist: r.artistName,
      title: r.collectionName,
      imageUrl: upscaleItunesUrl(r.artworkUrl100!),
      source: 'itunes' as const,
    }));
}

/* ------------------------------------------------- MusicBrainz / Cover Art */

/** Barcodes carry spaces and dashes in Discogs; comparison needs digits only. */
export function normaliseBarcode(raw: string): string {
  return raw.replace(/\D/g, '');
}

interface MbRelease {
  id: string;
  title: string;
  'artist-credit'?: Array<{ name: string }>;
}

/**
 * A barcode identifies a specific manufactured release, so a hit here is an
 * exact match — no fuzzy scoring, and the art is for the same pressing rather
 * than merely the same album.
 */
export async function findByBarcode(
  barcode: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Candidate | null> {
  const digits = normaliseBarcode(barcode);
  if (digits.length < 8) return null;

  const url =
    'https://musicbrainz.org/ws/2/release/?' +
    new URLSearchParams({ query: `barcode:${digits}`, fmt: 'json', limit: '1' }).toString();

  const body = await getJson<{ releases?: MbRelease[] }>(url, fetchImpl);
  const release = body?.releases?.[0];
  if (!release) return null;

  // Ask Cover Art Archive whether it holds a front image for this release.
  const caa = await getJson<{ images?: Array<{ front?: boolean; image?: string }> }>(
    `https://coverartarchive.org/release/${release.id}`,
    fetchImpl,
  );
  const front = caa?.images?.find((i) => i.front && i.image);
  if (!front?.image) return null;

  return {
    artist: release['artist-credit']?.[0]?.name ?? '',
    title: release.title,
    imageUrl: front.image,
    source: 'caa',
    exact: true,
  };
}
