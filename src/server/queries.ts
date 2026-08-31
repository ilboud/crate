import type { Db } from '../db/index.js';
import { getSetting } from '../db/index.js';

/**
 * Read queries backing the API. Kept apart from the route handlers so they can
 * be tested directly and reused by the chat assistant's local tools.
 */

export interface GroupSummary {
  name: string;
  count: number;
  hidden: boolean;
  sort_order: number;
}

const ALBUM_COLUMNS = `
  r.id, r.title, r.year, r.primary_group, r.thumb_path, r.cover_path,
  r.hi_path, r.art_source,
  (SELECT GROUP_CONCAT(a.name, ' / ')
     FROM release_artist ra JOIN artist a ON a.id = ra.artist_id
    WHERE ra.release_id = r.id) AS artist,
  (SELECT COUNT(*) FROM collection_item ci WHERE ci.release_id = r.id) AS copies`;

export function listGroups(db: Db): GroupSummary[] {
  const threshold = Number(getSetting(db, 'hide_group_below', '3'));
  const rows = db
    .prepare(
      `SELECT g.name AS name, g.sort_order AS sort_order, g.hidden AS hidden,
              (SELECT COUNT(*) FROM release r WHERE r.primary_group = g.name) AS count
         FROM taxonomy_group g
        ORDER BY g.sort_order, g.name`,
    )
    .all() as Array<{ name: string; sort_order: number; hidden: number; count: number }>;

  // A group can be hidden explicitly, or automatically for being too small to
  // be worth a top-level entry. Small groups stay reachable through search.
  return rows.map((r) => ({
    name: r.name,
    count: r.count,
    sort_order: r.sort_order,
    hidden: r.hidden === 1 || r.count < threshold,
  }));
}

export function listStyles(db: Db, group?: string): Array<{ style: string; count: number }> {
  const sql = group
    ? `SELECT rs.style AS style, COUNT(DISTINCT rs.release_id) AS count
         FROM release_style rs
         JOIN release r ON r.id = rs.release_id
         JOIN taxonomy_style ts ON ts.style = rs.style
         JOIN taxonomy_group g ON g.id = ts.group_id
        WHERE r.primary_group = ? AND g.name = ?
        GROUP BY rs.style ORDER BY count DESC, rs.style`
    : `SELECT rs.style AS style, COUNT(DISTINCT rs.release_id) AS count
         FROM release_style rs GROUP BY rs.style ORDER BY count DESC, rs.style`;
  return (group ? db.prepare(sql).all(group, group) : db.prepare(sql).all()) as Array<{
    style: string;
    count: number;
  }>;
}

export type SortKey = 'artist' | 'year' | 'added' | 'title';

const SORTS: Record<SortKey, string> = {
  artist: 'artist COLLATE NOCASE ASC, r.year ASC',
  title: 'r.title COLLATE NOCASE ASC',
  year: 'r.year DESC, artist COLLATE NOCASE ASC',
  added: 'added DESC, artist COLLATE NOCASE ASC',
};

export function browse(
  db: Db,
  opts: { group?: string; style?: string; artist?: string; sort?: SortKey },
): unknown[] {
  const where: string[] = [];
  const params: unknown[] = [];

  if (opts.group) {
    where.push('r.primary_group = ?');
    params.push(opts.group);
  }
  if (opts.style) {
    where.push('EXISTS (SELECT 1 FROM release_style rs WHERE rs.release_id = r.id AND rs.style = ?)');
    params.push(opts.style);
  }
  if (opts.artist) {
    where.push(
      `EXISTS (SELECT 1 FROM release_artist ra JOIN artist a ON a.id = ra.artist_id
                WHERE ra.release_id = r.id AND a.name = ?)`,
    );
    params.push(opts.artist);
  }

  const sort = SORTS[opts.sort ?? 'artist'];
  return db
    .prepare(
      `SELECT ${ALBUM_COLUMNS},
              (SELECT MIN(ci.date_added) FROM collection_item ci WHERE ci.release_id = r.id) AS added
         FROM release r
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY ${sort}`,
    )
    .all(...params);
}

export function getAlbum(db: Db, id: number): unknown | null {
  const album = db
    .prepare(`SELECT ${ALBUM_COLUMNS}, r.master_id FROM release r WHERE r.id = ?`)
    .get(id) as Record<string, unknown> | undefined;
  if (!album) return null;

  const tracks = db
    .prepare(
      `SELECT id, seq, position_raw, disc, side, index_on_side, title, duration_sec
         FROM track WHERE release_id = ? ORDER BY seq`,
    )
    .all(id) as Array<{
      id: number; seq: number; position_raw: string | null; disc: number;
      side: string | null; index_on_side: number | null; title: string; duration_sec: number | null;
    }>;

  // Group into discs, then sides, so the UI renders "Disc 2 / Side C" without
  // re-deriving structure. 67 of the collection's records are multi-disc.
  const discs = new Map<number, Map<string, typeof tracks>>();
  for (const t of tracks) {
    const sideKey = t.side ?? '';
    let sides = discs.get(t.disc);
    if (!sides) discs.set(t.disc, (sides = new Map()));
    const list = sides.get(sideKey);
    if (list) list.push(t);
    else sides.set(sideKey, [t]);
  }

  return {
    ...album,
    genres: (db.prepare('SELECT genre FROM release_genre WHERE release_id = ?').all(id) as Array<{ genre: string }>)
      .map((g) => g.genre),
    styles: (db.prepare('SELECT style FROM release_style WHERE release_id = ?').all(id) as Array<{ style: string }>)
      .map((s) => s.style),
    labels: db
      .prepare(
        `SELECT l.name AS name, rl.catno AS catno FROM release_label rl
           JOIN label l ON l.id = rl.label_id WHERE rl.release_id = ?`,
      )
      .all(id),
    formats: (db
      .prepare('SELECT name, qty, descriptions FROM release_format WHERE release_id = ? ORDER BY seq')
      .all(id) as Array<{ name: string; qty: number; descriptions: string }>)
      .map((f) => ({ ...f, descriptions: JSON.parse(f.descriptions) as string[] })),
    instances: db
      .prepare('SELECT instance_id, folder_id, date_added FROM collection_item WHERE release_id = ?')
      .all(id),
    discs: [...discs.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([disc, sides]) => ({
        disc,
        sides: [...sides.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([side, list]) => ({ side: side || null, tracks: list })),
      })),
    similar: similarFor(db, id, 0),
    moreByArtist: similarFor(db, id, 1),
  };
}

export function similarFor(db: Db, id: number, sameArtist: 0 | 1, limit = 6): unknown[] {
  return db
    .prepare(
      `SELECT ${ALBUM_COLUMNS}, s.score, s.reason
         FROM similar s JOIN release r ON r.id = s.other_id
        WHERE s.release_id = ? AND s.same_artist = ?
        ORDER BY s.score DESC LIMIT ?`,
    )
    .all(id, sameArtist, limit);
}

/**
 * FTS5 requires a well-formed query; raw user input like `blue in green"` or a
 * bare `*` throws. Quote each term and OR them, then also add a prefix match
 * on the last term so search feels responsive as you type.
 */
export function ftsQuery(raw: string): string | null {
  const terms = raw
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/["*()]/g, ''))
    .filter((t) => t.length > 0);
  if (terms.length === 0) return null;
  const quoted = terms.map((t) => `"${t}"`);
  const last = terms[terms.length - 1]!;
  return `(${quoted.join(' AND ')}) OR (${quoted.slice(0, -1).concat(`"${last}"*`).join(' AND ')})`;
}

export interface SearchResults {
  albums: unknown[];
  tracks: unknown[];
  artists: unknown[];
}

export function search(db: Db, raw: string, limit = 20): SearchResults {
  const q = ftsQuery(raw);
  if (!q) return { albums: [], tracks: [], artists: [] };

  const albums = db
    .prepare(
      `SELECT ${ALBUM_COLUMNS}
         FROM release_fts f JOIN release r ON r.id = f.release_id
        WHERE release_fts MATCH ? ORDER BY rank LIMIT ?`,
    )
    .all(q, limit);

  // A song can appear on several pressings; every one is returned, each
  // naming the record, disc and side it lives on.
  const tracks = db
    .prepare(
      `SELECT t.id, t.title, t.disc, t.side, t.index_on_side, t.duration_sec,
              r.id AS release_id, r.title AS album, r.year, r.thumb_path,
              (SELECT GROUP_CONCAT(a.name, ' / ')
                 FROM release_artist ra JOIN artist a ON a.id = ra.artist_id
                WHERE ra.release_id = r.id) AS artist
         FROM track_fts f
         JOIN track t ON t.id = f.track_id
         JOIN release r ON r.id = t.release_id
        WHERE track_fts MATCH ? ORDER BY rank LIMIT ?`,
    )
    .all(q, limit);

  const like = `%${raw.trim()}%`;
  const artists = db
    .prepare(
      `SELECT a.name AS name, COUNT(DISTINCT ra.release_id) AS count
         FROM artist a JOIN release_artist ra ON ra.artist_id = a.id
        WHERE a.name LIKE ? COLLATE NOCASE
        GROUP BY a.name ORDER BY count DESC, a.name LIMIT ?`,
    )
    .all(like, limit);

  return { albums, tracks, artists };
}

export function stats(db: Db): Record<string, unknown> {
  const one = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    releases: one('SELECT COUNT(*) AS n FROM release'),
    copies: one('SELECT COUNT(*) AS n FROM collection_item'),
    tracks: one('SELECT COUNT(*) AS n FROM track'),
    artists: one('SELECT COUNT(DISTINCT artist_id) AS n FROM release_artist'),
    lastSync: db
      .prepare('SELECT started_at, finished_at, ok_count, failed_ids FROM sync_run ORDER BY id DESC LIMIT 1')
      .get() ?? null,
  };
}
