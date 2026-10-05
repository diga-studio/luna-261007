import type { VersionRange } from "./types";
import { MAX_VERSION_CODE, MIN_VERSION_CODE, parseVersion, type VersionCode } from "./version";

/** 闭区间 [lo, hi]（均为版本编码，含端点）。 */
export interface ClosedInterval {
  lo: VersionCode;
  hi: VersionCode;
}

/** 把可缺省边界的区间规范化为闭区间；空区间（如下界高于上界）返回 null。 */
export function normalizeRange(range: VersionRange): ClosedInterval | null {
  let lo: VersionCode;
  if (range.lower === undefined) {
    lo = MIN_VERSION_CODE;
  } else {
    const code = parseVersion(range.lower.version);
    lo = range.lower.inclusive ? code : code + 1;
  }
  let hi: VersionCode;
  if (range.upper === undefined) {
    hi = MAX_VERSION_CODE;
  } else {
    const code = parseVersion(range.upper.version);
    hi = range.upper.inclusive ? code : code - 1;
  }
  if (lo > hi || lo > MAX_VERSION_CODE || hi < MIN_VERSION_CODE) {
    return null;
  }
  return { lo, hi };
}

/**
 * 从基础闭区间中扣除若干排除区间，返回不相交的剩余闭区间（按 lo 升序）。
 * 排除区间允许相互交叠或越出基础区间。
 */
export function subtractExclusions(
  base: ClosedInterval,
  exclusions: ClosedInterval[],
): ClosedInterval[] {
  const clipped: ClosedInterval[] = [];
  for (const ex of exclusions) {
    const lo = Math.max(ex.lo, base.lo);
    const hi = Math.min(ex.hi, base.hi);
    if (lo <= hi) {
      clipped.push({ lo, hi });
    }
  }
  clipped.sort((a, b) => a.lo - b.lo || a.hi - b.hi);

  const result: ClosedInterval[] = [];
  let cursor = base.lo;
  for (const ex of clipped) {
    if (ex.hi < cursor) {
      continue;
    }
    if (ex.lo > cursor) {
      result.push({ lo: cursor, hi: ex.lo - 1 });
    }
    cursor = ex.hi + 1;
    if (cursor > base.hi) {
      return result;
    }
  }
  if (cursor <= base.hi) {
    result.push({ lo: cursor, hi: base.hi });
  }
  return result;
}
