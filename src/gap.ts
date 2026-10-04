import type { Employee, Position } from "./types";

/**
 * 计算岗位-员工配对的万分数缺口：
 * gap = floor(10000 * Σ max(required-actual, 0)*weight / Σ required*weight)。
 * 缺失技能按 actual=0 处理。调用方保证岗位至少有一项要求。
 */
export function computeGap(position: Position, employee: Employee): number {
  let weightedGap = 0;
  let weightedRequired = 0;
  for (const req of position.requirements) {
    const actual = employee.skills[req.skill] ?? 0;
    const shortfall = req.required - actual;
    weightedGap += (shortfall > 0 ? shortfall : 0) * req.weight;
    weightedRequired += req.required * req.weight;
  }
  return Math.floor((10000 * weightedGap) / weightedRequired);
}
