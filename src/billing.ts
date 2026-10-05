import {
  Change,
  TIER_CPU_BASELINE,
  TIER_MONTHLY_CENTS,
  EXTRA_CPU_CENTS_PER_HOUR,
} from "./types";

export interface MonthCharge {
  month: string;
  amountCents: number;
}

const MS_PER_HOUR = 3_600_000n;

export function monthKeyOf(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

export function monthStartMs(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return Date.UTC(y, m - 1, 1);
}

export function monthEndMs(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return Date.UTC(y, m, 1);
}

/**
 * Recomputes exact per-month charges for one instance over [0, until)
 * from the current effective timeline (highest revisions, non-revoked,
 * sorted by `at`). Amounts are rounded half-up to integer cents once per
 * month, after exact rational accumulation of every running segment.
 */
export function computeCharges(changes: Change[], until: number): MonthCharge[] {
  // month -> exact rational accumulators
  const baseNum = new Map<string, bigint>(); // sum(tierMonthlyCents * ms)
  const cpuNum = new Map<string, bigint>(); // sum(extraCpu * centsPerHour * ms)

  const add = (map: Map<string, bigint>, key: string, v: bigint) => {
    map.set(key, (map.get(key) ?? 0n) + v);
  };

  for (let i = 0; i < changes.length; i++) {
    const c = changes[i];
    const snap = c.snapshot;
    if (!snap || snap.state !== "running") continue;
    const segStart = c.at;
    const segEnd = i + 1 < changes.length ? changes[i + 1].at : until;
    const end = Math.min(segEnd, until);
    if (segStart >= end) continue;

    const extraCpu = Math.max(0, snap.cpu - TIER_CPU_BASELINE[snap.tier]);
    const monthly = TIER_MONTHLY_CENTS[snap.tier];

    // Split the segment at UTC month boundaries.
    let cursor = segStart;
    while (cursor < end) {
      const month = monthKeyOf(cursor);
      const mEnd = monthEndMs(month);
      const sliceEnd = Math.min(end, mEnd);
      const ms = BigInt(sliceEnd - cursor);
      add(baseNum, month, BigInt(monthly) * ms);
      if (extraCpu > 0) {
        add(cpuNum, month, BigInt(extraCpu * EXTRA_CPU_CENTS_PER_HOUR) * ms);
      }
      cursor = sliceEnd;
    }
  }

  const months = new Set<string>([...baseNum.keys(), ...cpuNum.keys()]);
  const result: MonthCharge[] = [];
  for (const month of [...months].sort()) {
    const monthMs = BigInt(monthEndMs(month) - monthStartMs(month));
    // total = baseNum/monthMs + cpuNum/MS_PER_HOUR, rounded half-up.
    const d = monthMs * MS_PER_HOUR;
    const n =
      (baseNum.get(month) ?? 0n) * MS_PER_HOUR +
      (cpuNum.get(month) ?? 0n) * monthMs;
    const rounded = Number((2n * n + d) / (2n * d));
    result.push({ month, amountCents: rounded });
  }
  return result;
}
