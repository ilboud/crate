import type { Db } from '../db/index.js';
import type { Assignment, BasicInformation, Taxonomy } from '../shared/types.js';

/**
 * Assigns each release exactly one primary group, in four tiers.
 *
 * Discogs' own genres are too coarse ("Funk / Soul" covers everything) and its
 * styles too granular (136 distinct across 245 records, most appearing once),
 * so the app maps styles onto curated groups and resolves conflicts here.
 *
 *   1 override        hand-set in the admin screen; wins over every rule
 *   2 style-majority  the group matching most of the release's styles
 *   3 genre-tiebreak  ties broken by which contender the coarse genre endorses
 *   4 precedence      remaining ties by fixed order; genre alone if no styles
 *
 * Tier 3 matters: without it "Blonde On Blonde" (styles Folk Rock + Rhythm &
 * Blues) files under Soul / Funk rather than Rock.
 */
export function assignGroup(release: BasicInformation, tax: Taxonomy): Assignment {
  const override = tax.overrides.get(release.id);
  if (override) return { group: override, how: 'override' };

  const score = new Map<string, number>();
  for (const style of release.styles ?? []) {
    const group = tax.styleToGroup.get(style);
    if (group) score.set(group, (score.get(group) ?? 0) + 1);
  }

  if (score.size === 0) {
    for (const genre of release.genres ?? []) {
      const group = tax.genreToGroup.get(genre);
      if (group) return { group, how: 'genre-only' };
    }
    return { group: 'Unsorted', how: 'unsorted' };
  }

  const max = Math.max(...score.values());
  let top = [...score.keys()].filter((g) => score.get(g) === max);
  if (top.length === 1) return { group: top[0]!, how: 'style-majority' };

  const endorsed = new Set(
    (release.genres ?? []).map((g) => tax.genreToGroup.get(g)).filter((g): g is string => !!g),
  );
  const byGenre = top.filter((g) => endorsed.has(g));
  if (byGenre.length === 1) return { group: byGenre[0]!, how: 'genre-tiebreak' };
  if (byGenre.length > 1) top = byGenre;

  const order = (g: string) => {
    const i = tax.precedence.indexOf(g);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  top.sort((a, b) => order(a) - order(b));
  return { group: top[0]!, how: 'precedence' };
}

/** Read the taxonomy out of the database into the shape assignGroup wants. */
export function loadTaxonomy(db: Db): Taxonomy {
  const styleRows = db
    .prepare(
      `SELECT s.style AS style, g.name AS name
         FROM taxonomy_style s JOIN taxonomy_group g ON g.id = s.group_id`,
    )
    .all() as Array<{ style: string; name: string }>;

  const genreRows = db
    .prepare(
      `SELECT t.genre AS genre, g.name AS name
         FROM taxonomy_genre t JOIN taxonomy_group g ON g.id = t.group_id`,
    )
    .all() as Array<{ genre: string; name: string }>;

  const groupRows = db
    .prepare('SELECT name FROM taxonomy_group ORDER BY sort_order, id')
    .all() as Array<{ name: string }>;

  const overrideRows = db
    .prepare(
      `SELECT o.release_id AS release_id, g.name AS name
         FROM release_override o JOIN taxonomy_group g ON g.id = o.group_id`,
    )
    .all() as Array<{ release_id: number; name: string }>;

  return {
    styleToGroup: new Map(styleRows.map((r) => [r.style, r.name])),
    genreToGroup: new Map(genreRows.map((r) => [r.genre, r.name])),
    precedence: groupRows.map((r) => r.name),
    overrides: new Map(overrideRows.map((r) => [r.release_id, r.name])),
  };
}

/**
 * Recompute primary_group for every release. Cheap at collection scale, so the
 * admin screen calls it synchronously after any taxonomy edit.
 */
export function reassignAll(db: Db): Map<string, number> {
  const tax = loadTaxonomy(db);
  const releases = db
    .prepare('SELECT id, raw_json FROM release')
    .all() as Array<{ id: number; raw_json: string }>;

  const update = db.prepare('UPDATE release SET primary_group = ?, assign_method = ? WHERE id = ?');
  const counts = new Map<string, number>();

  db.transaction(() => {
    for (const row of releases) {
      const basic = JSON.parse(row.raw_json) as BasicInformation;
      const { group, how } = assignGroup({ ...basic, id: row.id }, tax);
      update.run(group, how, row.id);
      counts.set(group, (counts.get(group) ?? 0) + 1);
    }
  })();

  return counts;
}

/** Styles present in the collection that no group claims — surfaced in admin. */
export function unassignedStyles(db: Db): Array<{ style: string; count: number }> {
  return db
    .prepare(
      `SELECT rs.style AS style, COUNT(*) AS count
         FROM release_style rs
         LEFT JOIN taxonomy_style ts ON ts.style = rs.style
        WHERE ts.style IS NULL
        GROUP BY rs.style
        ORDER BY count DESC, style`,
    )
    .all() as Array<{ style: string; count: number }>;
}
