import type { Db } from '../db/index.js';
import type { SimilarRow } from '../shared/types.js';

/**
 * Content-based similarity between owned releases.
 *
 * Styles are weighted by inverse document frequency, which matters at this
 * collection size: sharing "Modal" (9 records) is a real signal, sharing
 * "Soul" (28) is weak. Without IDF every soul record looks similar to every
 * other and the rare, meaningful overlaps drown.
 *
 * Same-artist pairs are stored with a flag rather than excluded, so the UI can
 * show two rails. Scored into one list, a Miles Davis record simply recommends
 * five other Miles Davis records the owner already knows about.
 *
 * All pairs is ~30k comparisons at this size, so it is precomputed at sync and
 * looked up at request time.
 */

export interface SimilarInput {
  id: number;
  year: number | null;
  group: string | null;
  styles: Set<string>;
  genres: Set<string>;
  labels: Set<string>;
  artists: Set<string>;
}

const W_GENRE = 0.6;
const W_LABEL = 1.4;
const W_ERA = 1.2;
const ERA_SPAN = 15;
/** Keep only the strongest few per release; the tail is noise. */
const KEEP_PER_RELEASE = 12;

export function loadSimilarInputs(db: Db): SimilarInput[] {
  const releases = db
    .prepare('SELECT id, year, primary_group FROM release')
    .all() as Array<{ id: number; year: number | null; primary_group: string | null }>;

  const group = <T>(
    rows: Array<{ release_id: number; v: T }>,
  ): Map<number, Set<T>> => {
    const m = new Map<number, Set<T>>();
    for (const r of rows) {
      let s = m.get(r.release_id);
      if (!s) m.set(r.release_id, (s = new Set<T>()));
      s.add(r.v);
    }
    return m;
  };

  const styles = group(
    db.prepare('SELECT release_id, style AS v FROM release_style').all() as Array<{ release_id: number; v: string }>,
  );
  const genres = group(
    db.prepare('SELECT release_id, genre AS v FROM release_genre').all() as Array<{ release_id: number; v: string }>,
  );
  const labels = group(
    db.prepare(
      'SELECT rl.release_id AS release_id, l.name AS v FROM release_label rl JOIN label l ON l.id = rl.label_id',
    ).all() as Array<{ release_id: number; v: string }>,
  );
  const artists = group(
    db.prepare(
      'SELECT ra.release_id AS release_id, a.name AS v FROM release_artist ra JOIN artist a ON a.id = ra.artist_id',
    ).all() as Array<{ release_id: number; v: string }>,
  );

  return releases.map((r) => ({
    id: r.id,
    year: r.year,
    group: r.primary_group,
    styles: styles.get(r.id) ?? new Set(),
    genres: genres.get(r.id) ?? new Set(),
    labels: labels.get(r.id) ?? new Set(),
    artists: artists.get(r.id) ?? new Set(),
  }));
}

function intersect<T>(a: Set<T>, b: Set<T>): T[] {
  const out: T[] = [];
  for (const v of a) if (b.has(v)) out.push(v);
  return out;
}

export function computeSimilar(items: SimilarInput[]): SimilarRow[] {
  const n = items.length;
  const df = new Map<string, number>();
  for (const it of items) for (const s of it.styles) df.set(s, (df.get(s) ?? 0) + 1);

  // Smoothed IDF. The textbook log(N/df) turns NEGATIVE once a style appears
  // in more than half the collection, which would silently drop those pairs
  // instead of merely weighting them down — wrong for a collection that leans
  // heavily on one style. This form stays positive while preserving the
  // ordering that makes a rare style outrank a ubiquitous one.
  const idf = (style: string) => Math.log(1 + n / (1 + (df.get(style) ?? 0)));

  const rows: SimilarRow[] = [];

  for (const a of items) {
    const scored: SimilarRow[] = [];
    for (const b of items) {
      if (a.id === b.id) continue;

      const why: string[] = [];
      let score = 0;

      const sharedStyles = intersect(a.styles, b.styles);
      if (sharedStyles.length) {
        sharedStyles.sort((x, y) => idf(y) - idf(x));
        score += sharedStyles.reduce((t, s) => t + idf(s), 0);
        why.push(sharedStyles.slice(0, 2).join(' + '));
      }

      score += intersect(a.genres, b.genres).length * W_GENRE;

      const sharedLabels = intersect(a.labels, b.labels);
      if (sharedLabels.length) {
        score += W_LABEL;
        why.push(`on ${sharedLabels[0]}`);
      }

      if (a.year && b.year) {
        const gap = Math.abs(a.year - b.year);
        score += Math.max(0, W_ERA - gap / ERA_SPAN);
        if (gap <= 5) why.push('same era');
      }

      if (score <= 0) continue;

      const sameArtist = intersect(a.artists, b.artists).length > 0;
      scored.push({
        release_id: a.id,
        other_id: b.id,
        score,
        reason: sameArtist && why.length === 0 ? 'same artist' : why.join('; '),
        same_artist: sameArtist ? 1 : 0,
      });
    }

    // Keep the top N of each rail independently, so a release by a
    // heavily-represented artist still gets other-artist suggestions.
    const bySameArtist = (flag: number) =>
      scored
        .filter((r) => r.same_artist === flag)
        .sort((x, y) => y.score - x.score)
        .slice(0, KEEP_PER_RELEASE);

    rows.push(...bySameArtist(0), ...bySameArtist(1));
  }

  return rows;
}

export function storeSimilar(db: Db, rows: SimilarRow[]): void {
  db.transaction(() => {
    db.prepare('DELETE FROM similar').run();
    const ins = db.prepare(
      'INSERT OR REPLACE INTO similar (release_id, other_id, score, reason, same_artist) VALUES (?,?,?,?,?)',
    );
    for (const r of rows) ins.run(r.release_id, r.other_id, r.score, r.reason, r.same_artist);
  })();
}

export function rebuildSimilar(db: Db): number {
  const rows = computeSimilar(loadSimilarInputs(db));
  storeSimilar(db, rows);
  return rows.length;
}
