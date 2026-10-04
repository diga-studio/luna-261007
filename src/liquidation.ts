import { compare, fromInt, rational } from "./rational";
import type {
  AllocationResult,
  CapitalTable,
  CapitalTableInput,
  ClassAllocation,
  IntInput,
  Rational,
} from "./types";
import { normalizeTable } from "./types";

/**
 * A kink in the total-payout function P(r) at threshold r = tNum / tDen.
 * Applying an event shifts P's constant term by dA and slope by dB.
 */
interface SweepEvent {
  readonly tNum: bigint;
  readonly tDen: bigint;
  readonly dA: bigint;
  readonly dB: bigint;
}

interface Sweep {
  /** P(r) = constA + slopeB * r on the open segment starting at r = 0. */
  readonly constA: bigint;
  readonly slopeB: bigint;
  readonly events: SweepEvent[];
}

/**
 * Builds the piecewise-linear model of total payout P(r), where r is the
 * per-share common proceeds and every class makes its optimal (monotone)
 * choice: non-participating classes convert once r > L/s, capped
 * participating classes stop participating at r = (C-L)/s and convert once
 * r > C/s, uncapped participating classes never convert.
 */
function buildSweep(table: CapitalTable): Sweep {
  let constA = 0n;
  let slopeB = table.common.shares;
  const events: SweepEvent[] = [];
  for (const cls of table.preferred) {
    const { shares: s, preference: l, cap } = cls;
    constA += l;
    if (!cls.participating) {
      // L (slope 0) -> s*r (slope s) at r = L/s.
      events.push({ tNum: l, tDen: s, dA: -l, dB: s });
    } else if (cap === undefined) {
      // L + s*r forever: only contributes to the initial slope.
      slopeB += s;
    } else {
      // L + s*r -> C at r = (C-L)/s, then C -> s*r at r = C/s.
      slopeB += s;
      events.push({ tNum: cap - l, tDen: s, dA: cap - l, dB: -s });
      events.push({ tNum: cap, tDen: s, dA: -cap, dB: s });
    }
  }
  events.sort((a, b) => {
    const lhs = a.tNum * b.tDen;
    const rhs = b.tNum * a.tDen;
    if (lhs < rhs) return -1;
    if (lhs > rhs) return 1;
    return 0;
  });
  return { constA, slopeB, events };
}

function parseExitValue(exitValue: IntInput): bigint {
  let value: bigint;
  if (typeof exitValue === "bigint") {
    value = exitValue;
  } else if (typeof exitValue === "string" && /^-?[0-9]+$/.test(exitValue)) {
    value = BigInt(exitValue);
  } else {
    throw new Error("exitValue must be a decimal integer string or bigint");
  }
  if (value < 0n) {
    throw new Error("exitValue must be non-negative");
  }
  return value;
}

/**
 * Exact liquidation allocation at a given exit value (in cents).
 * Runs in O(n log n) for n preferred classes.
 */
export function allocate(
  table: CapitalTableInput,
  exitValue: IntInput,
): AllocationResult {
  const normalized = normalizeTable(table);
  const value = parseExitValue(exitValue);
  const sweep = buildSweep(normalized);
  const totalPreference = sweep.constA;

  const commonZero: ClassAllocation = {
    id: normalized.common.id,
    amount: fromInt(0n),
    converted: false,
  };

  // Below (or at) the aggregate preference, preferred classes share
  // everything pro-rata to L and keep their preferred status.
  if (value <= totalPreference) {
    return {
      common: commonZero,
      preferred: normalized.preferred.map((cls) => ({
        id: cls.id,
        amount: rational(value * cls.preference, totalPreference),
        converted: false,
      })),
    };
  }

  // Locate the linear segment of P(r) = constA + slopeB * r containing the
  // solution, applying every event whose threshold is strictly below r.
  let constA = sweep.constA;
  let slopeB = sweep.slopeB;
  for (const event of sweep.events) {
    // P(t) = (constA * tDen + slopeB * tNum) / tDen at the event threshold.
    if (value * event.tDen <= constA * event.tDen + slopeB * event.tNum) {
      break;
    }
    constA += event.dA;
    slopeB += event.dB;
  }
  // r = (value - constA) / slopeB, kept unreduced; all comparisons are exact.
  const rNum = value - constA;
  const rDen = slopeB;

  const common: ClassAllocation = {
    id: normalized.common.id,
    amount: rational(normalized.common.shares * rNum, rDen),
    converted: false,
  };

  const preferred = normalized.preferred.map((cls): ClassAllocation => {
    const { shares: s, preference: l, cap } = cls;
    if (!cls.participating) {
      // Convert only when s*r strictly beats L; ties keep preferred status.
      if (rNum * s > l * rDen) {
        return { id: cls.id, amount: rational(s * rNum, rDen), converted: true };
      }
      return { id: cls.id, amount: fromInt(l), converted: false };
    }
    if (cap === undefined) {
      return {
        id: cls.id,
        amount: rational(l * rDen + s * rNum, rDen),
        converted: false,
      };
    }
    // Capped participating: convert only when s*r strictly beats the cap.
    if (rNum * s > cap * rDen) {
      return { id: cls.id, amount: rational(s * rNum, rDen), converted: true };
    }
    const uncapped = l * rDen + s * rNum;
    const capped = cap * rDen;
    return {
      id: cls.id,
      amount: rational(uncapped < capped ? uncapped : capped, rDen),
      converted: false,
    };
  });

  return { common, preferred };
}

/**
 * All critical exit values (exact rationals, ascending, de-duplicated,
 * excluding 0) where any class's slope vs. exit value or conversion
 * state changes. Runs in O(n log n) time and O(n) extra space.
 */
export function breakpoints(table: CapitalTableInput): Rational[] {
  const normalized = normalizeTable(table);
  const sweep = buildSweep(normalized);
  const out: Rational[] = [];

  // Regime change at the aggregate preference: pro-rata sharing ends and
  // the common stock starts participating (r leaves 0).
  if (sweep.constA > 0n) {
    out.push(fromInt(sweep.constA));
  }

  let constA = sweep.constA;
  let slopeB = sweep.slopeB;
  let index = 0;
  const events = sweep.events;
  while (index < events.length) {
    const tNum = events[index]!.tNum;
    const tDen = events[index]!.tDen;
    // P is continuous, so evaluating before applying the group is exact.
    const point = rational(constA * tDen + slopeB * tNum, tDen);
    if (out.length === 0 || compare(out[out.length - 1]!, point) !== 0) {
      out.push(point);
    }
    do {
      constA += events[index]!.dA;
      slopeB += events[index]!.dB;
      index += 1;
    } while (
      index < events.length &&
      events[index]!.tNum * tDen === tNum * events[index]!.tDen
    );
  }
  return out;
}
