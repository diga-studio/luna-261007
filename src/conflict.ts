/**
 * 两条已解析排期之间的最早冲突求解。
 *
 * 核心观察：窗口最长不足 48 小时，两场相交则开放日相差不超过 2 天。
 * 对每对（A 的星期几, B 的星期几），能使开放日相差 d ∈ [-2,2] 的 d 在同余
 * 约束下至多一个；于是每对星期几至多一条“候选类”。类内候选开放日构成等差
 * 数列（步长 L = lcm(7NA, 7NB) 天）。
 *
 * 本地时钟重叠 ⟹ UTC 重叠（本地->UTC 映射严格单调）；UTC 重叠 ⟹ 本地重叠
 * 或候选落在 DST 转换日前后 ±4 天内（偏移差至多 1 小时）。后者只有每年两个
 * 转换日需要处理，且相对转换日的格局与年份无关，可用同余 + 400 年格里历
 * 周期直接解出最早可行年份，无需逐场枚举。
 */
import {
  fallBackDay,
  localToUtcMinutes,
  LocalKind,
  springForwardDay,
} from "./calendar.js";
import type { ParsedSchedule } from "./parsed.js";

export interface PairConflict {
  /** 相交起点（Unix 分钟）。 */
  overlapStartUtc: number;
  /** A 方场次开放日（序列日）。 */
  openDateA: number;
  /** B 方场次开放日（序列日）。 */
  openDateB: number;
}

const DAY_MINUTES = 1440;
/** 窗口相交时开放日之差的最大绝对值（窗口 < 48 小时）。 */
const MAX_DAY_DIFF = 2;
/** 特殊候选：开放日距 DST 转换日不超过该天数时需要精确判定。 */
const TRANSITION_RADIUS = 4;
/** 格里历 400 年周期的天数。 */
const GREGORIAN_CYCLE_DAYS = 146097;
const MIN_YEAR = 2008;
const MAX_YEAR = 9999;
const CYCLE_YEARS = 400;

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

/** 扩展欧几里得：返回 [g, u, v]，满足 u*a + v*b = g = gcd(a, b)，g > 0。 */
function extgcd(a: number, b: number): [number, number, number] {
  let oldR = a;
  let r = b;
  let oldS = 1;
  let s = 0;
  let oldT = 0;
  let t = 1;
  while (r !== 0) {
    const q = Math.floor(oldR / r);
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
    [oldT, t] = [t, oldT - q * t];
  }
  return [oldR, oldS, oldT];
}

function mod(a: number, b: number): number {
  return ((a % b) + b) % b;
}

/** b > 0 的向下取整除法（整数精确，避免浮点边界误差）。 */
function floorDiv(a: number, b: number): number {
  let q = Math.floor(a / b);
  while (q * b > a) q--;
  while ((q + 1) * b <= a) q++;
  return q;
}

/** b > 0 的向上取整除法。 */
function ceilDiv(a: number, b: number): number {
  return -floorDiv(-a, b);
}

/** 某排期在开放日 openDay 的场次窗口 [open, close)（Unix 分钟）；取消时返回 null。 */
function sessionWindow(
  schedule: ParsedSchedule,
  openDay: number,
): [number, number] | null {
  const open = localToUtcMinutes(openDay, schedule.openMin, LocalKind.Open);
  if (open === null) return null;
  const closeDay = openDay + (schedule.closeNextDay ? 1 : 0);
  const close = localToUtcMinutes(closeDay, schedule.closeMin, LocalKind.Close);
  if (close === null) return null;
  return [open, close];
}

/** DST 转换日种类：0=春季，1=秋季。 */
interface TransitionTables {
  /** base[s] = 转换日(2008 + s)，s ∈ [0, 400)。 */
  base: Int32Array;
}

const transitionTables: readonly TransitionTables[] = (() => {
  const make = (dayOf: (year: number) => number): TransitionTables => {
    const base = new Int32Array(CYCLE_YEARS);
    for (let s = 0; s < CYCLE_YEARS; s++) base[s] = dayOf(MIN_YEAR + s);
    return { base };
  };
  return [make(springForwardDay), make(fallBackDay)];
})();

/** 按 (转换种类, 模数 L) 缓存的同余求解表。 */
interface ResidueTable {
  /** residues[s] = base[s] mod L。 */
  residues: Int32Array;
  base: Int32Array;
  gq: number;
  stepQ: number;
  /** (146097/gq) 在模 stepQ 下的逆元；stepQ 为 1 时为 0。 */
  inv: number;
}

const residueTableCache = new Map<number, ResidueTable>();

function getResidueTable(kind: number, modulus: number): ResidueTable {
  const key = kind * 1_000_000 + modulus;
  let table = residueTableCache.get(key);
  if (table) return table;
  const { base } = transitionTables[kind]!;
  const residues = new Int32Array(CYCLE_YEARS);
  for (let s = 0; s < CYCLE_YEARS; s++) residues[s] = mod(base[s]!, modulus);
  const gq = gcd(GREGORIAN_CYCLE_DAYS, modulus);
  const stepQ = modulus / gq;
  let inv = 0;
  if (stepQ > 1) {
    const [, u] = extgcd(GREGORIAN_CYCLE_DAYS / gq, stepQ);
    inv = mod(u, stepQ);
  }
  table = { residues, base, gq, stepQ, inv };
  residueTableCache.set(key, table);
  return table;
}

/**
 * 求最早的转换日 T = 转换日(kind, y)（y ∈ [2008, 9999]），
 * 满足 T ≡ r (mod L) 且 Tmin ≤ T ≤ Tmax；不存在返回 null。
 */
function earliestTransitionDay(
  kind: number,
  r: number,
  modulus: number,
  tMin: number,
  tMax: number,
): number | null {
  if (tMin > tMax) return null;
  const table = getResidueTable(kind, modulus);
  const { residues, base, gq, stepQ, inv } = table;
  let best: number | null = null;
  for (let s = 0; s < CYCLE_YEARS; s++) {
    const rhs = mod(r - residues[s]!, modulus);
    if (rhs % gq !== 0) continue;
    const q0 = stepQ === 1 ? 0 : mod(Math.floor(rhs / gq) * inv, stepQ);
    const baseDay = base[s]!;
    let qMin = ceilDiv(tMin - baseDay, GREGORIAN_CYCLE_DAYS);
    if (qMin < 0) qMin = 0;
    let qMax = floorDiv(tMax - baseDay, GREGORIAN_CYCLE_DAYS);
    const qYearMax = Math.floor((MAX_YEAR - MIN_YEAR - s) / CYCLE_YEARS);
    if (qMax > qYearMax) qMax = qYearMax;
    let q = q0;
    if (q < qMin) q = q0 + ceilDiv(qMin - q0, stepQ) * stepQ;
    if (q > qMax) continue;
    const day = baseDay + q * GREGORIAN_CYCLE_DAYS;
    if (day >= tMin && day <= tMax && (best === null || day < best)) best = day;
  }
  return best;
}

/** 中国剩余定理（模数固定为 stepA、stepB，逆元预计算）：x ≡ rA (mod stepA)，x ≡ rB (mod stepB)。 */
function crtWith(ctx: ClassContext, rA: number, rB: number): number {
  const { stepA, stepB, g, invCrt, lcm } = ctx;
  const t = mod(Math.floor((rB - rA) / g) * invCrt, stepB / g);
  return mod(rA + stepA * t, lcm);
}

interface ClassContext {
  a: ParsedSchedule;
  b: ParsedSchedule;
  stepA: number;
  stepB: number;
  g: number;
  lcm: number;
  /** u*stepB + v*stepA = g。 */
  u: number;
  v: number;
  /** (stepA/g) 在模 (stepB/g) 下的逆元（stepB/g > 1 时）。 */
  invCrt: number;
  loA: number;
  hiA: number;
  loB: number;
  hiB: number;
  closeLocalA: number;
  closeLocalB: number;
  /** 按 (d) 缓存特殊格局重叠位掩码（bit = kind*9 + (e+4)）。 */
  overlapMaskCache: Map<number, number>;
}

/** 处理一条候选类（固定星期几对与开放日差 d），返回该类最早冲突。 */
function solveClass(
  ctx: ClassContext,
  sA: number,
  sB: number,
  d: number,
): PairConflict | null {
  const { a, b, stepA, stepB, g, lcm, u, v } = ctx;
  const diffSB = sB - sA;
  const c = d - diffSB;
  // stepB*kB - stepA*kA = c 的特解
  const kB0 = u * (c / g);
  const kA0 = -v * (c / g);
  const dA0 = sA + stepA * kA0;
  const lo = Math.max(ctx.loA, ctx.loB - d);
  const hi = Math.min(ctx.hiA, ctx.hiB - d);
  const tLo = ceilDiv(lo - dA0, lcm);
  const tHi = floorDiv(hi - dA0, lcm);
  if (tLo > tHi) return null;

  // 本地时钟重叠判定（窗口以 A 开放日为基准的分钟表示）
  const dMin = d * DAY_MINUTES;
  const localOverlap =
    a.openMin < dMin + ctx.closeLocalB && dMin + b.openMin < ctx.closeLocalA;

  if (localOverlap) {
    // 本地重叠 ⟹ UTC 重叠；只需跳过被取消（排除日 / 春季缺口）的候选。
    for (let t = tLo; t <= tHi; t++) {
      const dA = dA0 + lcm * t;
      const dB = dA + d;
      if (a.excluded.has(dA) || b.excluded.has(dB)) continue;
      const wA = sessionWindow(a, dA);
      if (wA === null) continue;
      const wB = sessionWindow(b, dB);
      if (wB === null) continue;
      return { overlapStartUtc: Math.max(wA[0], wB[0]), openDateA: dA, openDateB: dB };
    }
    return null;
  }

  // 本地不重叠：UTC 重叠只可能出现在 DST 转换日附近（偏移差 ≤ 1 小时）。
  // 先用 60 分钟松弛做必要条件过滤。
  const slackPossible =
    a.openMin < dMin + ctx.closeLocalB + 60 && dMin + b.openMin - 60 < ctx.closeLocalA;
  if (!slackPossible) return null;

  // 两类转换日 × 开放日相对偏移 e ∈ [-4, 4] 的格局，与年份无关。
  // 格局是否重叠只取决于双方钟面时间与 d，按 (d) 缓存位掩码。
  let mask = ctx.overlapMaskCache.get(d);
  if (mask === undefined) {
    mask = 0;
    for (let kind = 0; kind < 2; kind++) {
      for (let e = -TRANSITION_RADIUS; e <= TRANSITION_RADIUS; e++) {
        const refDay = transitionTables[kind]!.base[2020 - MIN_YEAR]! + e;
        const wARef = sessionWindow(a, refDay);
        if (wARef === null) continue;
        const wBRef = sessionWindow(b, refDay + d);
        if (wBRef === null) continue;
        if (wARef[0] < wBRef[1] && wBRef[0] < wARef[1]) {
          mask |= 1 << (kind * (2 * TRANSITION_RADIUS + 1) + e + TRANSITION_RADIUS);
        }
      }
    }
    ctx.overlapMaskCache.set(d, mask);
  }
  if (mask === 0) return null;

  let best: PairConflict | null = null;
  for (let kind = 0; kind < 2; kind++) {
    for (let e = -TRANSITION_RADIUS; e <= TRANSITION_RADIUS; e++) {
      if ((mask & (1 << (kind * (2 * TRANSITION_RADIUS + 1) + e + TRANSITION_RADIUS))) === 0) {
        continue;
      }
      // 同余可行性：转换日 T 需满足 T+e 在 A 的序列上、T+e+d 在 B 的序列上。
      const rA = mod(sA - e, stepA);
      const rB = mod(sB - e - d, stepB);
      if (mod(rB - rA, g) !== 0) continue;
      const r = crtWith(ctx, rA, rB);
      // 求最早可行年份（排除日命中时顺延）。
      const tMin = Math.max(ctx.loA, ctx.loB - d) - e;
      const tMax = Math.min(ctx.hiA, ctx.hiB - d) - e;
      let day = earliestTransitionDay(kind, r, lcm, tMin, tMax);
      while (day !== null && (a.excluded.has(day + e) || b.excluded.has(day + e + d))) {
        day = earliestTransitionDay(kind, r, lcm, day + 1, tMax);
      }
      if (day === null) continue;
      const dA = day + e;
      const dB = dA + d;
      const wA = sessionWindow(a, dA);
      const wB = sessionWindow(b, dB);
      if (wA === null || wB === null) continue;
      const instant = Math.max(wA[0], wB[0]);
      if (best === null || instant < best.overlapStartUtc) {
        best = { overlapStartUtc: instant, openDateA: dA, openDateB: dB };
      }
    }
  }
  return best;
}

/** 求两条排期在全有效期内的最早冲突；无冲突返回 null。 */
export function earliestConflictBetween(
  a: ParsedSchedule,
  b: ParsedSchedule,
): PairConflict | null {
  const stepA = a.stepDays;
  const stepB = b.stepDays;
  const g = gcd(stepA, stepB);
  const lcm = (stepA / g) * stepB;
  const [gu, u, v] = extgcd(stepB, stepA);
  void gu;
  let invCrt = 0;
  if (stepB / g > 1) {
    const [, ui] = extgcd(stepA / g, stepB / g);
    invCrt = mod(ui, stepB / g);
  }

  const ctx: ClassContext = {
    a,
    b,
    stepA,
    stepB,
    g,
    lcm,
    u,
    v,
    invCrt,
    loA: Math.max(a.anchor, a.validFrom),
    hiA: a.validTo,
    loB: Math.max(b.anchor, b.validFrom),
    hiB: b.validTo,
    closeLocalA: a.closeMin + (a.closeNextDay ? DAY_MINUTES : 0),
    closeLocalB: b.closeMin + (b.closeNextDay ? DAY_MINUTES : 0),
    overlapMaskCache: new Map(),
  };

  let best: PairConflict | null = null;
  for (let i = 0; i < a.weekdayFirst.length; i++) {
    const sA = a.weekdayFirst[i]!;
    for (let j = 0; j < b.weekdayFirst.length; j++) {
      const sB = b.weekdayFirst[j]!;
      // 可行的开放日差 d ∈ [-2, 2] 且 d ≡ sB - sA (mod g)，至多一个。
      const r0 = mod(sB - sA, g);
      let d: number | null = null;
      if (r0 <= MAX_DAY_DIFF) d = r0;
      else if (r0 - g >= -MAX_DAY_DIFF) d = r0 - g;
      if (d === null) continue;
      // 下界剪枝：该类最早候选开放日已不早于当前最优时跳过。
      if (best !== null) {
        const diffSB = sB - sA;
        const c = d - diffSB;
        const kB0 = u * (c / g);
        const kA0 = -v * (c / g);
        const dA0 = sA + stepA * kA0;
        const lo = Math.max(ctx.loA, ctx.loB - d);
        const tLo = ceilDiv(lo - dA0, lcm);
        const firstDay = dA0 + lcm * tLo;
        if (firstDay * DAY_MINUTES >= best.overlapStartUtc) continue;
      }
      const candidate = solveClass(ctx, sA, sB, d);
      if (candidate !== null && (best === null || candidate.overlapStartUtc < best.overlapStartUtc)) {
        best = candidate;
      }
    }
  }
  return best;
}
