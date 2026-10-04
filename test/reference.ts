import type { CapitalTable, Rational } from "../src/index";
import { normalizeTable } from "../src/index";

export interface ReferenceAllocation {
  readonly id: string;
  readonly amount: Rational;
  readonly converted: boolean;
}

export interface ReferenceResult {
  readonly common: ReferenceAllocation;
  readonly preferred: readonly ReferenceAllocation[];
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x === 0n ? 1n : x;
}

function rat(num: bigint, den: bigint): Rational {
  if (den < 0n) return rat(-num, -den);
  const g = gcd(num, den);
  return { num: num / g, den: den / g };
}

/**
 * Independent slow reference: enumerates every combination of conversion
 * set and cap-binding set, solves the resulting linear system exactly, and
 * keeps the (unique) self-consistent equilibrium. Ties are broken in favor
 * of keeping the preferred status, matching the specification.
 */
export function referenceAllocate(
  input: Parameters<typeof normalizeTable>[0],
  exitValue: bigint,
): ReferenceResult {
  const table = normalizeTable(input);
  const classes = table.preferred;
  const n = classes.length;
  const totalL = classes.reduce((acc, c) => acc + c.preference, 0n);

  if (exitValue <= totalL) {
    return {
      common: { id: table.common.id, amount: rat(0n, 1n), converted: false },
      preferred: classes.map((c) => ({
        id: c.id,
        amount: rat(exitValue * c.preference, totalL),
        converted: false,
      })),
    };
  }

  // Payoff of class i when it does not convert, at per-share rate rNum/rDen.
  const holdPayoff = (i: number, rNum: bigint, rDen: bigint): Rational => {
    const c = classes[i]!;
    if (!c.participating) return rat(c.preference, 1n);
    const uncapped = c.preference * rDen + c.shares * rNum;
    if (c.cap === undefined) return rat(uncapped, rDen);
    const capped = c.cap * rDen;
    return rat(uncapped < capped ? uncapped : capped, rDen);
  };

  const cappedIdx: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const c = classes[i]!;
    if (c.participating && c.cap !== undefined) cappedIdx.push(i);
  }

  const combos = 1n << BigInt(n);
  const capCombos = 1n << BigInt(cappedIdx.length);
  for (let conv = 0n; conv < combos; conv += 1n) {
    for (let caps = 0n; caps < capCombos; caps += 1n) {
      // A capped class that converts has no meaningful cap state; skip
      // guesses where a converted class is marked as capped.
      let invalid = false;
      for (let k = 0; k < cappedIdx.length; k += 1) {
        const i = cappedIdx[k]!;
        if (((caps >> BigInt(k)) & 1n) === 1n && ((conv >> BigInt(i)) & 1n) === 1n) {
          invalid = true;
          break;
        }
      }
      if (invalid) continue;

      let constant = 0n;
      let slope = table.common.shares;
      for (let i = 0; i < n; i += 1) {
        const c = classes[i]!;
        const converted = ((conv >> BigInt(i)) & 1n) === 1n;
        if (converted) {
          slope += c.shares;
          continue;
        }
        constant += c.preference;
        if (!c.participating) continue;
        const capped =
          c.cap !== undefined &&
          ((caps >> BigInt(cappedIdx.indexOf(i))) & 1n) === 1n;
        if (capped) {
          constant += c.cap! - c.preference;
        } else {
          slope += c.shares;
        }
      }

      const rNum = exitValue - constant;
      if (rNum < 0n) continue;
      const rDen = slope;

      // Verify the guess is a self-consistent equilibrium with the
      // tie-break rule (strict inequality required for conversion).
      let consistent = true;
      for (let i = 0; i < n && consistent; i += 1) {
        const c = classes[i]!;
        const hold = holdPayoff(i, rNum, rDen);
        const converted = ((conv >> BigInt(i)) & 1n) === 1n;
        // Compare convert value s*r against hold value, exactly.
        const lhs = c.shares * rNum * hold.den;
        const rhs = hold.num * rDen;
        if (converted) {
          if (lhs <= rhs) consistent = false;
        } else if (lhs > rhs) {
          consistent = false;
        }
        // Cap-state consistency for unconverted capped classes.
        if (consistent && c.participating && c.cap !== undefined && !converted) {
          const k = cappedIdx.indexOf(i);
          const markedCapped = ((caps >> BigInt(k)) & 1n) === 1n;
          const binds =
            c.preference * rDen + c.shares * rNum >= c.cap! * rDen;
          if (markedCapped !== binds) consistent = false;
        }
      }
      if (!consistent) continue;

      return {
        common: {
          id: table.common.id,
          amount: rat(table.common.shares * rNum, rDen),
          converted: false,
        },
        preferred: classes.map((c, i) => {
          const converted = ((conv >> BigInt(i)) & 1n) === 1n;
          return {
            id: c.id,
            amount: converted ? rat(c.shares * rNum, rDen) : holdPayoff(i, rNum, rDen),
            converted,
          };
        }),
      };
    }
  }
  throw new Error("reference: no consistent equilibrium found");
}
