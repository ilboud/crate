import type { ParsedPosition } from '../shared/types.js';

/**
 * Discogs encodes a vinyl track position as a side letter with an OPTIONAL
 * index, and never states the disc number. Both of these are real:
 *
 *   "A"   whole side A is one track   (Bitches Brew — Pharaoh's Dance, 20:07)
 *   "C2"  side C, second track        (Bitches Brew — John McLaughlin, 4:23)
 *
 * Requiring a digit silently drops every whole-side track, so the index is
 * optional in the pattern. Disc is derived from the side letter: A/B are disc
 * 1, C/D disc 2, and so on.
 *
 * Non-vinyl forms ("1-1", "1") and unparseable values fall back to the track's
 * sequence within the release.
 */
const VINYL = /^([A-Z]+)(\d*)$/;
const DISC_TRACK = /^(\d+)-(\d+)$/;
const NUMERIC = /^(\d+)$/;

/** "A"->1, "Z"->26, "AA"->27 — the side's ordinal across the whole release. */
function sideOrdinal(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

export function parsePosition(raw: string | undefined | null, seq: number): ParsedPosition {
  const pos = (raw ?? '').trim().toUpperCase();

  if (pos === '') return { disc: 1, side: null, indexOnSide: seq };

  const discTrack = DISC_TRACK.exec(pos);
  if (discTrack) {
    return {
      disc: Number(discTrack[1]),
      side: null,
      indexOnSide: Number(discTrack[2]),
    };
  }

  const vinyl = VINYL.exec(pos);
  if (vinyl) {
    const letters = vinyl[1]!;
    const index = vinyl[2]!;
    return {
      disc: Math.ceil(sideOrdinal(letters) / 2),
      side: letters,
      indexOnSide: index === '' ? null : Number(index),
    };
  }

  const numeric = NUMERIC.exec(pos);
  if (numeric) return { disc: 1, side: null, indexOnSide: Number(numeric[1]) };

  return { disc: 1, side: null, indexOnSide: seq };
}

/** "4:23" -> 263, "1:02:03" -> 3723. Null when absent or malformed. */
export function parseDuration(raw: string | undefined | null): number | null {
  const value = (raw ?? '').trim();
  if (value === '') return null;
  const parts = value.split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  if (!parts.every((p) => /^\d+$/.test(p))) return null;
  return parts.reduce((total, p) => total * 60 + Number(p), 0);
}

/** Heading shown above a run of tracks in the album view. */
export function sideLabel(p: ParsedPosition): string {
  return p.side ? `Side ${p.side}` : `Disc ${p.disc}`;
}
