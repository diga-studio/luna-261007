import type { RatioCategory } from './types';

/** 各比例类别每位教师最多照看人数 */
export const RATIO_PER_TEACHER: Record<RatioCategory, number> = {
  infant: 4,
  toddler: 6,
  preschool: 10,
};

/** 任何班级的通用人数上限 */
export const CLASS_HARD_CAP = 20;

/** 临时交接区容量：固定 1 名教师，最多 2 名儿童 */
export const HOLDING_CAPACITY = 2;

/**
 * 计算一个班在当前儿童组成下的允许人数。
 * 混龄班按在班儿童中最严格的比例管理，允许人数为
 * CLASS_HARD_CAP 与 教师人数 × 最严格比例 两者的较小值；
 * 空班没有儿童比例限制，允许人数为 CLASS_HARD_CAP。
 */
export function classCapacity(teachers: number, present: readonly RatioCategory[]): number {
  if (present.length === 0) {
    return CLASS_HARD_CAP;
  }
  let strictest = Infinity;
  for (const category of present) {
    strictest = Math.min(strictest, RATIO_PER_TEACHER[category]);
  }
  return Math.min(CLASS_HARD_CAP, teachers * strictest);
}

/** 判断一个班当前是否合规 */
export function isClassCompliant(teachers: number, present: readonly RatioCategory[]): boolean {
  return present.length <= classCapacity(teachers, present);
}
