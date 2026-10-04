import type { Model } from "./model.js";

/**
 * One state-change event at per-share rate r = num/den.
 * When the event fires, slope += slopeDelta and constant += constDelta,
 * keeping total payout = r * slope + constant continuous in r.
 */
export interface SweepEvent {
  num: bigint;
  den: bigint;
  slopeDelta: bigint;
  constDelta: bigint;
}

export interface Sweep {
  /** Events sorted by ascending r. */
  events: SweepEvent[];
  /** Shares currently paid per unit of r, just above r = 0. */
  initialSlope: bigint;
  /** Constant part of total payout just above r = 0 (always the total preference). */
  initialConstant: bigint;
}

/** Compares two events by their r value. */
export function compareEvents(a: SweepEvent, b: SweepEvent): number {
  const lhs = a.num * b.den;
  const rhs = b.num * a.den;
  return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
}

export function buildSweep(model: Model): Sweep {
  const events: SweepEvent[] = [];
  let initialSlope = model.commonShares;
  const initialConstant = model.totalPreference;
  for (const cls of model.preferred) {
    const s = cls.shares;
    const L = cls.liquidation;
    const C = cls.cap;
    if (!cls.participating) {
      // Converts once s*r exceeds L.
      events.push({ num: L, den: s, slopeDelta: s, constDelta: -L });
    } else if (C === null) {
      // Uncapped participating: always earns L + s*r, never converts.
      initialSlope += s;
    } else {
      if (C > L) {
        // Reaches its cap once s*r exceeds C - L.
        events.push({ num: C - L, den: s, slopeDelta: -s, constDelta: C - L });
        initialSlope += s;
      }
      // Converts once s*r exceeds C.
      events.push({ num: C, den: s, slopeDelta: s, constDelta: -C });
    }
  }
  events.sort(compareEvents);
  return { events, initialSlope, initialConstant };
}
