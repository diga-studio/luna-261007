import { rational, cmpR } from "./rational.js";
import type { Rational } from "./rational.js";
import { normalizeTable } from "./model.js";
import { buildSweep } from "./sweep.js";
import type { CapitalTable } from "./types.js";

/**
 * Every exit valuation in (0, +inf) where some class's payout slope or
 * conversion status changes, as reduced rationals, ascending, deduplicated.
 */
export function breakpoints(table: CapitalTable): Rational[] {
  const model = normalizeTable(table);
  if (model.preferred.length === 0) {
    return [];
  }
  const result: Rational[] = [];
  // At V = sum(L) the pro-rata regime ends and the per-share regime begins.
  result.push(rational(model.totalPreference));
  const sweep = buildSweep(model);
  let slope = sweep.initialSlope;
  let constant = sweep.initialConstant;
  let index = 0;
  while (index < sweep.events.length) {
    const event = sweep.events[index]!;
    const gnum = event.num;
    const gden = event.den;
    // Valuation at which this event group fires: V = r * slope + constant.
    result.push(rational(gnum * slope + constant * gden, gden));
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
  result.sort(cmpR);
  return result.filter((value, i) => i === 0 || cmpR(value, result[i - 1]!) !== 0);
}
