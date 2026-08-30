import { describe, it, expect } from 'vitest';
import { parsePosition, parseDuration, sideLabel } from '../../src/sync/position.js';

describe('parsePosition', () => {
  it('treats a bare side letter as a whole-side track', () => {
    // Real case: Bitches Brew side A is one 20-minute track, position "A".
    // A parser requiring a digit drops these entirely.
    expect(parsePosition('A', 1)).toEqual({ disc: 1, side: 'A', indexOnSide: null });
    expect(parsePosition('B', 2)).toEqual({ disc: 1, side: 'B', indexOnSide: null });
  });

  it('derives disc number from the side letter', () => {
    expect(parsePosition('A', 1).disc).toBe(1);
    expect(parsePosition('B', 2).disc).toBe(1);
    expect(parsePosition('C', 3).disc).toBe(2);
    expect(parsePosition('D', 4).disc).toBe(2);
    expect(parsePosition('E', 5).disc).toBe(3);
    expect(parsePosition('F', 6).disc).toBe(3);
    expect(parsePosition('G', 7).disc).toBe(4);
  });

  it('parses indexed vinyl positions', () => {
    expect(parsePosition('C1', 3)).toEqual({ disc: 2, side: 'C', indexOnSide: 1 });
    expect(parsePosition('C2', 4)).toEqual({ disc: 2, side: 'C', indexOnSide: 2 });
    expect(parsePosition('D4', 8)).toEqual({ disc: 2, side: 'D', indexOnSide: 4 });
  });

  it('handles lowercase and whitespace', () => {
    expect(parsePosition(' c2 ', 4)).toEqual({ disc: 2, side: 'C', indexOnSide: 2 });
    expect(parsePosition('a', 1)).toEqual({ disc: 1, side: 'A', indexOnSide: null });
  });

  it('parses CD-style disc-track positions', () => {
    expect(parsePosition('1-1', 1)).toEqual({ disc: 1, side: null, indexOnSide: 1 });
    expect(parsePosition('2-5', 9)).toEqual({ disc: 2, side: null, indexOnSide: 5 });
  });

  it('parses plain numeric positions', () => {
    expect(parsePosition('1', 1)).toEqual({ disc: 1, side: null, indexOnSide: 1 });
    expect(parsePosition('12', 12)).toEqual({ disc: 1, side: null, indexOnSide: 12 });
  });

  it('falls back to sequence for empty or unrecognized positions', () => {
    // Headings and index tracks carry an empty position.
    expect(parsePosition('', 7)).toEqual({ disc: 1, side: null, indexOnSide: 7 });
    expect(parsePosition('???', 3)).toEqual({ disc: 1, side: null, indexOnSide: 3 });
  });

  it('handles double-letter sides on box sets', () => {
    // AA follows Z; treated as the side after, not as disc 1.
    const r = parsePosition('AA1', 1);
    expect(r.side).toBe('AA');
    expect(r.indexOnSide).toBe(1);
    expect(r.disc).toBeGreaterThan(13);
  });
});

describe('parseDuration', () => {
  it('parses mm:ss', () => {
    expect(parseDuration('4:23')).toBe(263);
    expect(parseDuration('20:07')).toBe(1207);
    expect(parseDuration('0:47')).toBe(47);
  });

  it('parses h:mm:ss', () => {
    expect(parseDuration('1:02:03')).toBe(3723);
  });

  it('returns null for missing or malformed values', () => {
    expect(parseDuration('')).toBeNull();
    expect(parseDuration(undefined)).toBeNull();
    expect(parseDuration('unknown')).toBeNull();
  });
});

describe('sideLabel', () => {
  it('describes vinyl sides', () => {
    expect(sideLabel({ disc: 2, side: 'C', indexOnSide: 1 })).toBe('Side C');
  });

  it('describes CD tracks without a side', () => {
    expect(sideLabel({ disc: 1, side: null, indexOnSide: 3 })).toBe('Disc 1');
  });
});
