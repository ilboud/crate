import { describe, it, expect } from 'vitest';
import {
  MAX_FLICK_RECORDS,
  MIN_FLICK_VELOCITY,
  easeOutCubic,
  flickDurationMs,
  projectFlick,
  stepPxFor,
  velocityFrom,
} from './flick';

const base = { index: 100, stepPx: 120, count: 243, momentum: 'medium' as const };

describe('velocityFrom', () => {
  it('is zero without enough samples', () => {
    expect(velocityFrom([])).toBe(0);
    expect(velocityFrom([{ x: 0, t: 0 }])).toBe(0);
  });

  it('measures px per millisecond', () => {
    // 200px over 100ms is 2 px/ms.
    expect(velocityFrom([{ x: 0, t: 0 }, { x: 200, t: 100 }])).toBeCloseTo(2, 5);
  });

  it('is negative when the pointer moved left', () => {
    expect(velocityFrom([{ x: 200, t: 0 }, { x: 0, t: 100 }])).toBeCloseTo(-2, 5);
  });

  it('reads a pause before lift as a stop, ignoring the earlier fast drag', () => {
    // Thrown fast, then held still for 120ms. Releasing should not glide.
    const samples = [
      { x: 0, t: 0 }, { x: 400, t: 100 },
      { x: 402, t: 180 }, { x: 402, t: 260 },
    ];
    expect(Math.abs(velocityFrom(samples))).toBeLessThan(MIN_FLICK_VELOCITY);
  });

  it('ignores the slow start of a long drag that ended fast', () => {
    const samples = [
      { x: 0, t: 0 }, { x: 10, t: 400 },      // slow
      { x: 150, t: 460 }, { x: 300, t: 500 }, // then flicked
    ];
    expect(velocityFrom(samples)).toBeGreaterThan(2);
  });

  it('is zero when no time passed', () => {
    expect(velocityFrom([{ x: 0, t: 5 }, { x: 90, t: 5 }])).toBe(0);
  });
});

describe('projectFlick', () => {
  it('does not move when momentum is off — the old behaviour', () => {
    expect(projectFlick({ ...base, velocity: 5, momentum: 'off' })).toBe(100);
  });

  it('does not glide below the flick threshold', () => {
    expect(projectFlick({ ...base, velocity: 0.2 })).toBe(100);
  });

  it('carries further the faster the flick', () => {
    const slow = projectFlick({ ...base, velocity: -1 });
    const fast = projectFlick({ ...base, velocity: -4 });
    expect(fast).toBeGreaterThan(slow);
    expect(slow).toBeGreaterThan(100);
  });

  it('carries further on higher momentum for the same flick', () => {
    const low = projectFlick({ ...base, velocity: -2, momentum: 'low' });
    const high = projectFlick({ ...base, velocity: -2, momentum: 'high' });
    expect(high).toBeGreaterThan(low);
  });

  it('moves toward earlier records when the pointer went right', () => {
    // Positive velocity pulls earlier records into view, lowering the index.
    expect(projectFlick({ ...base, velocity: 2 })).toBeLessThan(100);
  });

  it('stops at the start of the collection', () => {
    expect(projectFlick({ ...base, index: 3, velocity: 9 })).toBe(0);
  });

  it('stops at the end of the collection', () => {
    expect(projectFlick({ ...base, index: 240, velocity: -9 })).toBe(242);
  });

  it('caps a single flick so it cannot cross the whole crate', () => {
    const target = projectFlick({ ...base, velocity: -80 });
    expect(target - 100).toBeLessThanOrEqual(MAX_FLICK_RECORDS);
  });

  it('handles an empty collection', () => {
    expect(projectFlick({ ...base, count: 0, velocity: -3 })).toBe(0);
  });

  it('does not divide by a zero step', () => {
    expect(projectFlick({ ...base, stepPx: 0, velocity: -3 })).toBe(100);
  });

  it('travels further per flick when the step is smaller', () => {
    const coarse = projectFlick({ ...base, stepPx: 200, velocity: -3 });
    const fine = projectFlick({ ...base, stepPx: 60, velocity: -3 });
    expect(fine).toBeGreaterThan(coarse);
  });
});

describe('flickDurationMs', () => {
  it('is zero when nothing moves', () => {
    expect(flickDurationMs(0)).toBe(0);
  });

  it('grows with distance but stays bounded', () => {
    expect(flickDurationMs(1)).toBeLessThan(flickDurationMs(8));
    expect(flickDurationMs(100)).toBeLessThanOrEqual(900);
  });

  it('is the same in either direction', () => {
    expect(flickDurationMs(-6)).toBe(flickDurationMs(6));
  });
});

describe('easeOutCubic', () => {
  it('runs from 0 to 1', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
  });

  it('is front-loaded, as a decelerating flick should be', () => {
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
  });

  it('clamps input outside 0..1', () => {
    expect(easeOutCubic(-1)).toBe(0);
    expect(easeOutCubic(2)).toBe(1);
  });
});

describe('stepPxFor', () => {
  it('scales with the sleeve', () => {
    expect(stepPxFor(400, 0.42)).toBeCloseTo(168);
  });

  it('never gets so small that the crate becomes twitchy', () => {
    expect(stepPxFor(10, 0.05)).toBe(24);
  });
});
