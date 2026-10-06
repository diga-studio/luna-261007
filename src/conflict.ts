import { firstSundayOfNovember, yearOf } from "./date";
import { sessionWindow, type CompiledSchedule } from "./schedule";

/** 两条排期间最早冲突的描述。 */
export interface PairConflict {
  /** 最早相交瞬间（UTC 分钟数）。 */
  instantUtc: number;
  /** 第一条排期冲突场次的开放日。 */
  openDayA: number;
  /** 第二条排期冲突场次的开放日。 */
  openDayB: number;
}

const MINUTES_PER_DAY = 1440;

function gcd(a: number, b: number): number {
  let x = a;
  let y = b;
  while (y !== 0) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

function floorMod(a: number, m: number): number {
  return ((a % m) + m) % m;
}

/** b 必须为正。 */
function ceilDiv(a: number, b: number): number {
  return -Math.floor(-a / b);
}

/** a 与 m 互质且 m > 1 时求 a 模 m 的逆元。 */
function modInv(a: number, m: number): number {
  let oldR = a;
  let r = m;
  let oldS = 1;
  let s = 0;
  while (r !== 0) {
    const q = Math.floor(oldR / r);
    const tr = oldR - q * r;
    oldR = r;
    r = tr;
    const ts = oldS - q * s;
    oldS = s;
    s = ts;
  }
  return floorMod(oldS, m);
}

/**
 * 求周序号 w 的同余类：w ≡ anchorA (mod nA) 且 w + c ≡ anchorB (mod nB)。
 * 有解时返回 { r, L }：w ≡ r (mod L)；无解返回 null。
 */
function weekProgression(
  anchorA: number,
  nA: number,
  anchorB: number,
  nB: number,
  c: number,
): { r: number; L: number } | null {
  const g = gcd(nA, nB);
  const diff = anchorB - c - anchorA;
  if (diff % g !== 0) return null;
  const L = nA * (nB / g);
  const mB = nB / g;
  if (mB === 1) return { r: floorMod(anchorA, L), L };
  const t = floorMod((diff / g) * modInv(floorMod(nA / g, mB), mB), mB);
  return { r: floorMod(anchorA + nA * t, L), L };
}

/** 周一为第 0 天：周 w 的周一 = 7w + 6（2008-01-07 为第 0 周周一）。 */
function mondayOfWeek(w: number): number {
  return 7 * w + 6;
}

/**
 * 检查单个 (dA, dB, c) 组合：A 在 dA 星期、B 在 dB 星期、B 的周 = A 的周 + c。
 * 返回该组合下的最早冲突，无则 null。
 */
function comboConflict(
  a: CompiledSchedule,
  dA: number,
  b: CompiledSchedule,
  dB: number,
  c: number,
): PairConflict | null {
  const prog = weekProgression(
    a.anchorWeek,
    a.intervalWeeks,
    b.anchorWeek,
    b.intervalWeeks,
    c,
  );
  if (!prog) return null;
  const { r, L } = prog;
  const wMin = Math.max(
    a.anchorWeek,
    b.anchorWeek - c,
    ceilDiv(a.validFromDay - 6 - dA, 7),
    ceilDiv(b.validFromDay - 6 - dB, 7) - c,
  );
  const wMax = Math.min(
    Math.floor((a.validToDay - 6 - dA) / 7),
    Math.floor((b.validToDay - 6 - dB) / 7) - c,
  );
  const firstW = r + L * ceilDiv(wMin - r, L);
  if (firstW > wMax) return null;

  // 相对本地分钟窗口（以 A 所在周的周一零点为基准）。
  const oA = dA * MINUTES_PER_DAY + a.openMinute;
  const cA = dA * MINUTES_PER_DAY + a.closeMinute + (a.closeNextDay ? MINUTES_PER_DAY : 0);
  const oB = (dB + 7 * c) * MINUTES_PER_DAY + b.openMinute;
  const cB = (dB + 7 * c) * MINUTES_PER_DAY + b.closeMinute + (b.closeNextDay ? MINUTES_PER_DAY : 0);
  const normalOverlap = Math.max(oA, oB) < Math.min(cA, cB);
  const sensA =
    (dA === 6 && a.sensitiveSunday) || (dA === 5 && a.sensitiveSaturday);
  const sensB =
    (dB === 6 && b.sensitiveSunday) || (dB === 5 && b.sensitiveSaturday);

  if (normalOverlap) {
    // 常规周窗口相交；春季 DST 周可能取消/破坏，逐周向前走（次数有界）。
    for (let w = firstW; w <= wMax; w += L) {
      const openDayA = mondayOfWeek(w) + dA;
      const openDayB = mondayOfWeek(w + c) + dB;
      if (a.excludedDays.has(openDayA) || b.excludedDays.has(openDayB)) {
        continue;
      }
      const wa = sessionWindow(a, openDayA);
      const wb = sessionWindow(b, openDayB);
      if (
        wa !== null &&
        wb !== null &&
        Math.max(wa.openUtc, wb.openUtc) < Math.min(wa.closeUtc, wb.closeUtc)
      ) {
        return {
          instantUtc: Math.max(wa.openUtc, wb.openUtc),
          openDayA,
          openDayB,
        };
      }
    }
    return null;
  }

  // 常规周窗口不相交：只有秋季回拨可能让窗口在真实时间上相交。
  if (!sensA && !sensB) return null;
  // 创造相交的必要条件：本地间隙小于 60 分钟。
  if (!(oB < cA + 60 && oA < cB + 60)) return null;
  const yMin = yearOf(mondayOfWeek(firstW) - 7);
  const yMax = yearOf(mondayOfWeek(wMax) + 13);
  for (let y = yMin; y <= yMax; y++) {
    const s = firstSundayOfNovember(y);
    const wBase = Math.floor((s - 6) / 7);
    // A 侧受影响时候选周为 wBase；B 侧受影响时候选周为 wBase - c。
    let best: PairConflict | null = null;
    if (sensA) {
      const hit = tryFallWeek(a, dA, b, dB, c, r, L, firstW, wMax, wBase);
      if (hit) best = hit;
    }
    if (sensB) {
      const hit = tryFallWeek(a, dA, b, dB, c, r, L, firstW, wMax, wBase - c);
      if (hit && (!best || hit.instantUtc < best.instantUtc)) best = hit;
    }
    if (best) return best;
  }
  return null;
}

function tryFallWeek(
  a: CompiledSchedule,
  dA: number,
  b: CompiledSchedule,
  dB: number,
  c: number,
  r: number,
  L: number,
  firstW: number,
  wMax: number,
  w: number,
): PairConflict | null {
  if (w < firstW || w > wMax) return null;
  if (floorMod(w - r, L) !== 0) return null;
  const openDayA = mondayOfWeek(w) + dA;
  const openDayB = mondayOfWeek(w + c) + dB;
  if (a.excludedDays.has(openDayA) || b.excludedDays.has(openDayB)) return null;
  const wa = sessionWindow(a, openDayA);
  const wb = sessionWindow(b, openDayB);
  if (
    wa !== null &&
    wb !== null &&
    Math.max(wa.openUtc, wb.openUtc) < Math.min(wa.closeUtc, wb.closeUtc)
  ) {
    return {
      instantUtc: Math.max(wa.openUtc, wb.openUtc),
      openDayA,
      openDayB,
    };
  }
  return null;
}

/**
 * 求两条已编译排期在全有效期内的最早冲突；无冲突返回 null。
 * 假定调用方已确认取货点相同且共享至少一个 SKU。
 */
export function earliestConflict(
  a: CompiledSchedule,
  b: CompiledSchedule,
): PairConflict | null {
  let best: PairConflict | null = null;
  for (let dA = 0; dA < 7; dA++) {
    if ((a.weekdayMask & (1 << dA)) === 0) continue;
    for (let dB = 0; dB < 7; dB++) {
      if ((b.weekdayMask & (1 << dB)) === 0) continue;
      const delta = dB - dA;
      // 开放日相差不超过 1 天才可能相交：c=0 需 |delta|<=1；c=1 需 delta=-6；c=-1 需 delta=6。
      if (delta >= -1 && delta <= 1) {
        const hit = comboConflict(a, dA, b, dB, 0);
        if (hit && (!best || hit.instantUtc < best.instantUtc)) best = hit;
      } else if (delta === -6) {
        const hit = comboConflict(a, dA, b, dB, 1);
        if (hit && (!best || hit.instantUtc < best.instantUtc)) best = hit;
      } else if (delta === 6) {
        const hit = comboConflict(a, dA, b, dB, -1);
        if (hit && (!best || hit.instantUtc < best.instantUtc)) best = hit;
      }
    }
  }
  return best;
}
