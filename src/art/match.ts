/**
 * Deciding whether a candidate cover really is the record you own.
 *
 * This is the whole risk of the feature. A search for "A Tribe Called Quest
 * The Low End Theory" returned "We got it from Here... Thank You 4 Your
 * service" from iTunes during testing — confidently, and top-ranked. Wrong art
 * on the shelf is worse than slightly soft art, so anything short of a strong
 * match is rejected and the Discogs image is kept.
 */

/** Strip the noise that makes two names for the same record look different. */
export function normalise(raw: string): string {
  return raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    // Discogs disambiguates same-named artists with a trailing "(2)".
    .replace(/\(\d+\)/g, ' ')
    // Edition noise that differs between services but not between records.
    .replace(
      /\b(remaster(ed)?|reissue|deluxe|expanded|anniversary|edition|version|mono|stereo|explicit|clean|bonus track[s]?|digital|remix)\b/g,
      ' ',
    )
    .replace(/\b(feat|featuring|with)\b.*$/g, ' ')
    .replace(/[\[\](){}]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|a|an|and|of|el|la|le|les)\b/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Dice coefficient over character bigrams: 1 is identical, 0 shares nothing. */
export function similarity(a: string, b: string): number {
  const x = normalise(a);
  const y = normalise(b);
  if (x === '' || y === '') return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return x === y ? 1 : 0;

  const bigrams = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };

  const ba = bigrams(x);
  const bb = bigrams(y);
  let shared = 0;
  let total = 0;
  for (const n of ba.values()) total += n;
  for (const n of bb.values()) total += n;
  for (const [g, n] of ba) shared += Math.min(n, bb.get(g) ?? 0);
  return (2 * shared) / total;
}

export interface Candidate {
  artist: string;
  title: string;
  imageUrl: string;
  source: 'itunes' | 'caa';
  /** Set when the match came from a barcode, which needs no fuzzy check. */
  exact?: boolean;
}

export interface MatchTarget {
  artist: string;
  title: string;
}

export interface Verdict {
  ok: boolean;
  artistScore: number;
  titleScore: number;
  reason: string;
}

// Both must pass. A high title score with the wrong artist is exactly the
// failure mode that puts a stranger's sleeve on your shelf.
export const ARTIST_THRESHOLD = 0.72;
export const TITLE_THRESHOLD = 0.78;

export function verify(target: MatchTarget, candidate: Candidate): Verdict {
  if (candidate.exact) {
    return { ok: true, artistScore: 1, titleScore: 1, reason: 'barcode match' };
  }

  // Discogs joins collaborations as "Miles Davis / John Coltrane"; a service
  // may list only the first. Score against the best single credit too.
  const credits = target.artist.split(/\s*\/\s*/).filter(Boolean);
  const artistScore = Math.max(
    similarity(target.artist, candidate.artist),
    ...credits.map((c) => similarity(c, candidate.artist)),
  );
  const titleScore = similarity(target.title, candidate.title);

  if (artistScore < ARTIST_THRESHOLD) {
    return {
      ok: false,
      artistScore,
      titleScore,
      reason: `artist "${candidate.artist}" scored ${artistScore.toFixed(2)}`,
    };
  }
  if (titleScore < TITLE_THRESHOLD) {
    return {
      ok: false,
      artistScore,
      titleScore,
      reason: `title "${candidate.title}" scored ${titleScore.toFixed(2)}`,
    };
  }
  return {
    ok: true,
    artistScore,
    titleScore,
    reason: `${candidate.source} ${artistScore.toFixed(2)}/${titleScore.toFixed(2)}`,
  };
}
