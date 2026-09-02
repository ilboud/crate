import type { Db } from '../db/index.js';
import { normalise } from '../art/match.js';

/**
 * Finding records the collection holds twice.
 *
 * The naive definition — the same release id appearing twice — catches almost
 * nothing, because Discogs files every pressing under its own id. The real
 * doubles in this collection are two *different* release ids for one album,
 * and telling an accident from a deliberate purchase is the whole problem:
 * owning an original and a reissue of the same record is normal, so an app
 * that flags those as errors is wrong more often than it is right.
 *
 * The catalogue number decides it. Two entries sharing one catalogue number
 * describe one pressing filed twice; two entries with different catalogue
 * numbers are different objects, shown as a note rather than a problem.
 */

export type DoubleKind = 'same-copy' | 'same-pressing' | 'reissue';

export interface DoubleInstance {
  instanceId: number;
  folderId: number | null;
  dateAdded: string | null;
}

export interface DoubleCopy {
  releaseId: number;
  title: string;
  artist: string;
  year: number | null;
  format: string;
  catnos: string[];
  art: string | null;
  instances: DoubleInstance[];
}

export interface DoubleGroup {
  /** Stable across runs, so the UI can key on it. */
  key: string;
  kind: DoubleKind;
  /** One line explaining why these are grouped, shown verbatim in the UI. */
  why: string;
  copies: DoubleCopy[];
}

/**
 * Catalogue numbers are written inconsistently — "SD 33-332", "SD33332",
 * "sd-33-332" — so everything but letters and digits goes. A purely numeric
 * catalogue number is kept despite being ambiguous: it is only ever compared
 * within one artist and title, which do the disambiguating.
 */
export function normaliseCatno(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Group key for "the same album", ignoring which pressing it is. */
export function albumKey(artist: string, title: string): string {
  return `${normalise(artist)} ${normalise(title)}`;
}

interface Row {
  id: number;
  title: string;
  year: number | null;
  artist: string | null;
  thumb_path: string | null;
  cover_path: string | null;
  hi_path: string | null;
}

interface FormatRow {
  name: string;
  qty: number;
  descriptions: string | null;
}

/** `descriptions` is stored as a JSON array; anything else is treated as absent. */
function readDescriptions(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function describeFormat(parts: FormatRow[]): string {
  if (!parts.length) return 'Unknown format';
  return parts
    .map((f) => {
      const qty = f.qty > 1 ? `${f.qty} × ` : '';
      const desc = readDescriptions(f.descriptions);
      return `${qty}${f.name}${desc.length ? ` (${desc.join(', ')})` : ''}`;
    })
    .join(' + ');
}

function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/** Pairs the user has marked "not a double", keyed lowest id first. */
export function readIgnored(db: Db): Set<string> {
  const rows = db.prepare('SELECT a_id, b_id FROM duplicate_ignore').all() as Array<{
    a_id: number;
    b_id: number;
  }>;
  return new Set(rows.map((r) => pairKey(r.a_id, r.b_id)));
}

export function ignorePair(db: Db, a: number, b: number): void {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  db.prepare('INSERT OR REPLACE INTO duplicate_ignore (a_id, b_id, noted_at) VALUES (?,?,?)').run(
    lo,
    hi,
    new Date().toISOString(),
  );
}

export function unignorePair(db: Db, a: number, b: number): void {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  db.prepare('DELETE FROM duplicate_ignore WHERE a_id = ? AND b_id = ?').run(lo, hi);
}

/** Every unordered pair in a group, as stable keys. */
function pairsOf(ids: number[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) out.push(pairKey(ids[i]!, ids[j]!));
  }
  return out;
}

/** The first catalogue number two of these releases share, if any. */
function sharedCatno(sets: Array<Set<string>>): string | null {
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      for (const c of sets[i]!) if (sets[j]!.has(c)) return c;
    }
  }
  return null;
}

export function findDoubles(db: Db): DoubleGroup[] {
  const releases = db
    .prepare(
      `SELECT r.id, r.title, r.year, r.thumb_path, r.cover_path, r.hi_path,
              (SELECT a.name FROM release_artist ra JOIN artist a ON a.id = ra.artist_id
                WHERE ra.release_id = r.id ORDER BY ra.seq LIMIT 1) AS artist
         FROM release r`,
    )
    .all() as Row[];

  const catnos = new Map<number, string[]>();
  for (const row of db
    .prepare("SELECT release_id, catno FROM release_label WHERE catno IS NOT NULL AND catno != ''")
    .all() as Array<{ release_id: number; catno: string }>) {
    const list = catnos.get(row.release_id) ?? [];
    if (!list.includes(row.catno)) list.push(row.catno);
    catnos.set(row.release_id, list);
  }

  const formats = new Map<number, FormatRow[]>();
  for (const row of db
    .prepare('SELECT release_id, name, qty, descriptions FROM release_format ORDER BY seq')
    .all() as Array<FormatRow & { release_id: number }>) {
    const list = formats.get(row.release_id) ?? [];
    list.push(row);
    formats.set(row.release_id, list);
  }

  const instances = new Map<number, DoubleInstance[]>();
  for (const row of db
    .prepare(
      'SELECT instance_id, release_id, folder_id, date_added FROM collection_item ORDER BY date_added',
    )
    .all() as Array<{
    instance_id: number;
    release_id: number;
    folder_id: number | null;
    date_added: string | null;
  }>) {
    const list = instances.get(row.release_id) ?? [];
    list.push({ instanceId: row.instance_id, folderId: row.folder_id, dateAdded: row.date_added });
    instances.set(row.release_id, list);
  }

  const copyOf = (row: Row): DoubleCopy => ({
    releaseId: row.id,
    title: row.title,
    artist: row.artist ?? 'Unknown artist',
    year: row.year,
    format: describeFormat(formats.get(row.id) ?? []),
    catnos: catnos.get(row.id) ?? [],
    art: row.hi_path ?? row.cover_path ?? row.thumb_path,
    instances: instances.get(row.id) ?? [],
  });

  const ignored = readIgnored(db);
  const groups: DoubleGroup[] = [];

  // Tier 1: one release id, more than one copy owned. Unambiguous — Discogs
  // itself records two of the same thing.
  for (const row of releases) {
    const owned = instances.get(row.id) ?? [];
    if (owned.length < 2) continue;
    // Owning two of one pressing is unusual but not wrong — a spare copy, or a
    // second for the decks. Recorded as a pair with itself so it can be
    // dismissed like any other.
    if (ignored.has(pairKey(row.id, row.id))) continue;
    groups.push({
      key: `copy:${row.id}`,
      kind: 'same-copy',
      why: `${owned.length} copies of this exact pressing are in the collection.`,
      copies: [copyOf(row)],
    });
  }

  // Tiers 2 and 3: several release ids for one album.
  const byAlbum = new Map<string, Row[]>();
  for (const row of releases) {
    const key = albumKey(row.artist ?? '', row.title);
    const list = byAlbum.get(key) ?? [];
    list.push(row);
    byAlbum.set(key, list);
  }

  for (const rows of byAlbum.values()) {
    if (rows.length < 2) continue;
    // Only worth showing while a copy is actually owned.
    if (!rows.some((r) => (instances.get(r.id) ?? []).length > 0)) continue;

    const ids = rows.map((r) => r.id).sort((a, b) => a - b);
    if (pairsOf(ids).every((p) => ignored.has(p))) continue;

    const shared = sharedCatno(
      rows.map((r) => new Set((catnos.get(r.id) ?? []).map(normaliseCatno))),
    );
    const copies = rows.map(copyOf).sort((a, b) => (a.year ?? 0) - (b.year ?? 0));

    groups.push({
      key: `album:${ids.join('-')}`,
      kind: shared ? 'same-pressing' : 'reissue',
      why: shared
        ? `Both entries carry catalogue number ${copies[0]!.catnos[0] ?? shared}, ` +
          'so they describe one pressing filed twice.'
        : 'Different catalogue numbers, so these are different pressings — ' +
          'you may own both on purpose.',
      copies,
    });
  }

  // Strongest signal first; the reissue notes sit at the bottom.
  const rank: Record<DoubleKind, number> = { 'same-copy': 0, 'same-pressing': 1, reissue: 2 };
  return groups.sort(
    (a, b) => rank[a.kind] - rank[b.kind] || a.copies[0]!.artist.localeCompare(b.copies[0]!.artist),
  );
}
