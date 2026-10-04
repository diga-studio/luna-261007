import { rational } from "./rational.js";
import type { Rational } from "./rational.js";
import { normalizeTable, toBigInt } from "./model.js";
import type { Model, PreferredClass } from "./model.js";
import { buildSweep } from "./sweep.js";
import type { Allocation, BigIntLike, CapitalTable, PreferredAllocation } from "./types.js";

/**
 * Solves the per-share common rate r for exit value V > sum(L) by sweeping
 * the state-change events in ascending r until the interval containing the
 * unique consistent solution is found. Total payout is r * slope + constant,
 * continuous and strictly increasing in r.
 */
function solveRate(model: Model, exitValue: bigint): Rational {
  const sweep = buildSweep(model);
  let slope = sweep.initialSlope;
  let constant = sweep.initialConstant;
  let index = 0;
  while (index < sweep.events.length) {
    const event = sweep.events[index]!;
    const gnum = event.num;
    const gden = event.den;
    // Stop when V <= gnum/gden * slope + constant, i.e. the solution lies
    // at or before this event group.
    if ((exitValue - constant) * gden <= gnum * slope) {
      return rational(exitValue - constant, slope);
    }
    let end = index + 1;
    while (end < sweep.events.length) {
      const next = sweep.events[end]!;
      if (next.num * gden !== gnum * next.den) {
        break;
      }
      end += 1;
    }
    for (let k = index; k < end; k += 1) {
      slope += sweep.events[k]!.slopeDelta;
      constant += sweep.events[k]!.constDelta;
    }
    index = end;
  }
  return rational(exitValue - constant, slope);
}

function allocatePreferred(cls: PreferredClass, rnum: bigint, rden: bigint): PreferredAllocation {
  const s = cls.shares;
  const L = cls.liquidation;
  const C = cls.cap;
  const shareProceeds = s * rnum; // s * r, scaled by rden
  if (!cls.participating) {
    const converted = shareProceeds > L * rden;
    return {
      id: cls.id,
      amount: converted ? rational(shareProceeds, rden) : rational(L),
      converted,
    };
  }
  if (C === null) {
    return { id: cls.id, amount: rational(L * rden + shareProceeds, rden), converted: false };
  }
  if (shareProceeds > C * rden) {
    // Conversion beats the capped payoff.
    return { id: cls.id, amount: rational(shareProceeds, rden), converted: true };
  }
  const uncapped = L * rden + shareProceeds;
  const capped = C * rden;
  return {
    id: cls.id,
    amount: rational(uncapped <= capped ? uncapped : capped, rden),
    converted: false,
  };
}

export function allocate(table: CapitalTable, exitValue: BigIntLike): Allocation {
  const model = normalizeTable(table);
  const V = toBigInt(exitValue, "exitValue");
  if (V < 0n) {
    throw new Error("exitValue must be a non-negative integer");
  }
  if (model.preferred.length === 0) {
    return { common: rational(V), preferred: [] };
  }
  if (V <= model.totalPreference) {
    // Not enough to cover the preferences: pro-rata by L, nobody converts.
    return {
      common: rational(0n),
      preferred: model.preferred.map((cls) => ({
        id: cls.id,
        amount: rational(V * cls.liquidation, model.totalPreference),
        converted: false,
      })),
    };
  }
  const rate = solveRate(model, V);
  const common = rational(model.commonShares * rate.num, rate.den);
  const preferred = model.preferred.map((cls) => allocatePreferred(cls, rate.num, rate.den));
  return { common, preferred };
}
