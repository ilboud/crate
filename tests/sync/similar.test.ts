import { describe, it, expect } from 'vitest';
import { computeSimilar, type SimilarInput } from '../../src/sync/similar.js';

function rec(
  id: number,
  opts: Partial<{ year: number; styles: string[]; genres: string[]; labels: string[]; artists: string[] }> = {},
): SimilarInput {
  return {
    id,
    year: opts.year ?? null,
    group: null,
    styles: new Set(opts.styles ?? []),
    genres: new Set(opts.genres ?? []),
    labels: new Set(opts.labels ?? []),
    artists: new Set(opts.artists ?? ['Artist ' + id]),
  };
}

/** Recommendations for `id`, strongest first, excluding same-artist. */
function otherArtistRecs(rows: ReturnType<typeof computeSimilar>, id: number): number[] {
  return rows
    .filter((r) => r.release_id === id && r.same_artist === 0)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.other_id);
}

describe('computeSimilar', () => {
  it('ranks a rare shared style above a common one', () => {
    // "Soul" is everywhere; "Modal" is rare. IDF should make Modal win.
    const items = [
      rec(1, { styles: ['Modal', 'Soul'] }),
      rec(2, { styles: ['Modal'] }),
      rec(3, { styles: ['Soul'] }),
      ...Array.from({ length: 12 }, (_, i) => rec(100 + i, { styles: ['Soul'] })),
    ];
    const recs = otherArtistRecs(computeSimilar(items), 1);
    expect(recs[0]).toBe(2);
  });

  it('separates same-artist pairs onto their own rail', () => {
    const items = [
      rec(1, { styles: ['Modal'], artists: ['Miles Davis'] }),
      rec(2, { styles: ['Modal'], artists: ['Miles Davis'] }),
      rec(3, { styles: ['Modal'], artists: ['Bill Evans'] }),
    ];
    const rows = computeSimilar(items);

    const same = rows.filter((r) => r.release_id === 1 && r.same_artist === 1);
    const other = rows.filter((r) => r.release_id === 1 && r.same_artist === 0);
    expect(same.map((r) => r.other_id)).toEqual([2]);
    expect(other.map((r) => r.other_id)).toEqual([3]);
  });

  it('credits a shared label', () => {
    const items = [
      rec(1, { styles: ['Modal'], labels: ['Columbia'] }),
      rec(2, { styles: ['Modal'], labels: ['Columbia'] }),
      rec(3, { styles: ['Modal'], labels: ['Blue Note'] }),
    ];
    const rows = computeSimilar(items);
    const withLabel = rows.find((r) => r.release_id === 1 && r.other_id === 2)!;
    const without = rows.find((r) => r.release_id === 1 && r.other_id === 3)!;
    expect(withLabel.score).toBeGreaterThan(without.score);
    expect(withLabel.reason).toContain('on Columbia');
  });

  it('credits era proximity and decays with distance', () => {
    const items = [
      rec(1, { styles: ['Modal'], year: 1959 }),
      rec(2, { styles: ['Modal'], year: 1961 }),
      rec(3, { styles: ['Modal'], year: 2015 }),
    ];
    const rows = computeSimilar(items);
    const near = rows.find((r) => r.release_id === 1 && r.other_id === 2)!;
    const far = rows.find((r) => r.release_id === 1 && r.other_id === 3)!;
    expect(near.score).toBeGreaterThan(far.score);
    expect(near.reason).toContain('same era');
  });

  it('explains every recommendation', () => {
    const items = [
      rec(1, { styles: ['Modal'], labels: ['Columbia'], year: 1959 }),
      rec(2, { styles: ['Modal'], labels: ['Columbia'], year: 1960 }),
    ];
    const rows = computeSimilar(items);
    expect(rows[0]!.reason).toBeTruthy();
    expect(rows[0]!.reason).toContain('Modal');
  });

  it('never recommends a release to itself', () => {
    const items = [rec(1, { styles: ['Modal'] }), rec(2, { styles: ['Modal'] })];
    const rows = computeSimilar(items);
    expect(rows.every((r) => r.release_id !== r.other_id)).toBe(true);
  });

  it('emits nothing for a release sharing no signal', () => {
    const items = [
      rec(1, { styles: ['Modal'] }),
      rec(2, { styles: ['Grime'] }),
    ];
    const rows = computeSimilar(items);
    expect(rows.filter((r) => r.release_id === 1)).toHaveLength(0);
  });

  it('caps each rail so one prolific artist cannot crowd out the other rail', () => {
    const items = [
      rec(1, { styles: ['Modal'], artists: ['A'] }),
      ...Array.from({ length: 30 }, (_, i) => rec(200 + i, { styles: ['Modal'], artists: ['A'] })),
      ...Array.from({ length: 30 }, (_, i) => rec(300 + i, { styles: ['Modal'], artists: ['B'] })),
    ];
    const rows = computeSimilar(items);
    const same = rows.filter((r) => r.release_id === 1 && r.same_artist === 1);
    const other = rows.filter((r) => r.release_id === 1 && r.same_artist === 0);
    expect(same.length).toBe(12);
    expect(other.length).toBe(12);
  });
});
