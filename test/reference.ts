// Independent slow reference implementation used only by tests.
// It shares input parsing (src/model.ts) and rational utilities (src/rational.ts)
// with the production code, but none of the sweep algorithm: for every
// candidate interval it re-derives every class's state from scratch, and it
// computes breakpoint valuations by evaluating the total payout at each
// class's event rate directly. O(n) per candidate, O(n^2) overall.
import { rational, addR, mulR, cmpR } from "../src/rational.js";
import type { Rational } from "../src/rational.js";
import { normalizeTable, toBigInt } from "../src/model.js";
import type { Model, PreferredClass } from "../src/model.js";
import type { Allocation, BigIntLike, CapitalTable, PreferredAllocation } from "../src/types.js";

function payoffAt(cls: PreferredClass, r: Rational): { amount: Rational; converted: boolean } {
  const s = cls.shares;
  const L = cls.liquidation;
  const C = cls.cap;
  const shareProceeds = mulR(rational(s), r);
  if (!cls.participating) {
    const converted = cmpR(shareProceeds, rational(L)) > 0;
    return { amount: converted ? shareProceeds : rational(L), converted };
  }
  if (C === null) {
    return { amount: addR(rational(L), shareProceeds), converted: false };
  }
  if (cmpR(shareProceeds, rational(C)) > 0) {
    return { amount: shareProceeds, converted: true };
  }
  const participating = addR(rational(L), shareProceeds);
  const capped = cmpR(participating, rational(C)) <= 0 ? participating : rational(C);
  return { amount: capped, converted: false };
}

function totalPayoutAt(model: Model, r: Rational): Rational {
  let total = mulR(rational(model.commonShares), r);
  for (const cls of model.preferred) {
    total = addR(total, payoffAt(cls, r).amount);
  }
  return total;
}

/** All distinct event rates of the classes, ascending. */
function eventRates(model: Model): Rational[] {
  const rates: Rational[] = [];
  for (const cls of model.preferred) {
    const s = cls.shares;
    const L = cls.liquidation;
    const C = cls.cap;
    if (!cls.participating) {
      rates.push(rational(L, s));
    } else if (C !== null) {
      rates.push(rational(C - L, s));
      rates.push(rational(C, s));
    }
  }
  rates.sort(cmpR);
  return rates.filter((value, i) => i === 0 || cmpR(value, rates[i - 1]!) !== 0);
}

export function referenceAllocate(table: CapitalTable, exitValue: BigIntLike): Allocation {
  const model = normalizeTable(table);
  const V = toBigInt(exitValue, "exitValue");
  if (V < 0n) {
    throw new Error("exitValue must be a non-negative integer");
  }
  if (model.preferred.length === 0) {
    return { common: rational(V), preferred: [] };
  }
  if (V <= model.totalPreference) {
    return {
      common: rational(0n),
      preferred: model.preferred.map((cls) => ({
        id: cls.id,
        amount: rational(V * cls.liquidation, model.totalPreference),
        converted: false,
      })),
    };
  }
  // Candidate intervals between consecutive event rates, plus the tails.
  const rates = eventRates(model);
  const bounds: Array<{ lo: Rational; hi: Rational | null }> = [];
  let lo = rational(0n);
  for (const rate of rates) {
    bounds.push({ lo, hi: rate });
    lo = rate;
  }
  bounds.push({ lo, hi: null });
  for (const { lo: lower, hi: upper } of bounds) {
    // State inside this interval: every event rate <= lower has fired.
    let slope = model.commonShares;
    let constant = 0n;
    for (const cls of model.preferred) {
      const s = cls.shares;
      const L = cls.liquidation;
      const C = cls.cap;
      if (!cls.participating) {
        if (cmpR(rational(L, s), lower) <= 0) {
          slope += s;
        } else {
          constant += L;
        }
      } else if (C === null) {
        slope += s;
        constant += L;
      } else if (cmpR(rational(C, s), lower) <= 0) {
        slope += s;
      } else if (cmpR(rational(C - L, s), lower) <= 0) {
        constant += C;
      } else {
        slope += s;
        constant += L;
      }
    }
    const r = rational(V - constant, slope);
    if (cmpR(r, lower) >= 0 && (upper === null || cmpR(r, upper) <= 0)) {
      const common = mulR(rational(model.commonShares), r);
      const preferred = model.preferred.map((cls) => {
        const result = payoffAt(cls, r);
        return { id: cls.id, amount: result.amount, converted: result.converted };
      });
      return { common, preferred };
    }
  }
  throw new Error("reference: no consistent interval found");
}

export function referenceBreakpoints(table: CapitalTable): Rational[] {
  const model = normalizeTable(table);
  if (model.preferred.length === 0) {
    return [];
  }
  const values: Rational[] = [rational(model.totalPreference)];
  for (const rate of eventRates(model)) {
    if (rate.num === 0n) {
      continue; // r = 0 maps to V = sum(L), already included
    }
    values.push(totalPayoutAt(model, rate));
  }
  values.sort(cmpR);
  return values.filter((value, i) => i === 0 || cmpR(value, values[i - 1]!) !== 0);
}
