/**
 * Flick physics for the crate.
 *
 * The original drag was positional only — index = start - round(dx / step) —
 * so a fast flick advanced exactly as far as a slow drag of the same distance
 * and then stopped dead. On a touch screen that reads as sluggish: you throw
 * the crate and it refuses to coast.
 *
 * Now the pointer still moves the crate 1:1 while it is down (direct
 * manipulation is what makes it feel like a physical stack), and on release
 * the recent pointer velocity projects a glide that decelerates.
 *
 * Kept pure and separate from the component so the behaviour can be tested
 * without a browser.
 */

export type Momentum = 'off' | 'low' | 'medium' | 'high';

/**
 * Time constant of the deceleration, in milliseconds. Travel after release is
 * velocity x tau, which is the integral of an exponential decay — the same
 * shape a spinning record settles with.
 */
const TAU: Record<Momentum, number> = {
  off: 0,
  low: 110,
  medium: 240,
  high: 420,
};

/** Below this the pointer was resting, not thrown; a nudge should not glide. */
export const MIN_FLICK_VELOCITY = 0.35; // px per ms

/** A single flick should never cross the whole collection. */
export const MAX_FLICK_RECORDS = 25;

export interface Sample {
  x: number;
  t: number;
}

/**
 * Velocity in px/ms from recent pointer samples, measured over the trailing
 * window. A short window keeps it responsive to the last motion rather than
 * averaging in the slow start of a long drag — and if the finger paused before
 * lifting, that pause correctly reads as zero.
 */
export function velocityFrom(samples: readonly Sample[], windowMs = 100): number {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1]!;

  let first = samples[0]!;
  for (let i = samples.length - 1; i >= 0; i--) {
    first = samples[i]!;
    if (last.t - first.t >= windowMs) break;
  }

  const dt = last.t - first.t;
  if (dt <= 0) return 0;
  return (last.x - first.x) / dt;
}

export interface FlickOptions {
  velocity: number;
  index: number;
  /** Pixels of drag that advance one record. */
  stepPx: number;
  count: number;
  momentum: Momentum;
}

/**
 * Where the crate should come to rest after the pointer lifts.
 *
 * Positive velocity means the pointer was moving right, which pulls earlier
 * records into view and therefore lowers the index — the same sign convention
 * the drag itself uses.
 */
export function projectFlick({
  velocity,
  index,
  stepPx,
  count,
  momentum,
}: FlickOptions): number {
  if (count <= 0) return 0;
  const clamp = (i: number) => Math.max(0, Math.min(count - 1, i));

  if (momentum === 'off' || stepPx <= 0) return clamp(index);
  if (Math.abs(velocity) < MIN_FLICK_VELOCITY) return clamp(index);

  const travelPx = velocity * TAU[momentum];
  const records = Math.round(travelPx / stepPx);
  const capped = Math.max(-MAX_FLICK_RECORDS, Math.min(MAX_FLICK_RECORDS, records));

  return clamp(index - capped);
}

/**
 * How long the glide should take. Longer for a bigger throw, but bounded so a
 * long flick never feels like waiting for the crate to finish.
 */
export function flickDurationMs(records: number): number {
  const n = Math.abs(records);
  if (n === 0) return 0;
  return Math.min(140 + n * 42, 900);
}

/** Ease-out cubic: fast off the mark, settling gently, like a real flick. */
export function easeOutCubic(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return 1 - Math.pow(1 - clamped, 3);
}

/** Drag distance that advances one record, given the sleeve size. */
export function stepPxFor(sleevePx: number, sensitivity: number): number {
  return Math.max(24, sleevePx * sensitivity);
}
