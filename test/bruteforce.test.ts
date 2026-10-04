import test from "node:test";
import assert from "node:assert/strict";
import { planSuccession } from "../src/index";
import type { CandidateEntry, Employee, Position, SuccessionModel } from "../src/index";

interface Metrics {
  readonly c0: number;
  readonly c1: number;
  readonly c2: number;
  readonly maxGap: number;
  readonly totalGap: number;
}

/** 字典序比较: 返回负数表示 a 更优。 */
const compare = (a: Metrics, b: Metrics): number =>
  b.c0 - a.c0 || b.c1 - a.c1 || b.c2 - a.c2 || a.maxGap - b.maxGap || a.totalGap - b.totalGap;

/** 暴力枚举所有合法预留方案, 返回字典序最优指标。 */
function bruteForce(model: SuccessionModel, gapOf: (p: string, e: string) => number): Metrics {
  const byPosition = new Map<string, CandidateEntry[]>();
  for (const c of model.candidates) {
    const list = byPosition.get(c.positionId) ?? [];
    list.push(c);
    byPosition.set(c.positionId, list);
  }
  let best: Metrics = { c0: 0, c1: 0, c2: 0, maxGap: 0, totalGap: 0 };
  const used = new Set<string>();
  const chosen: CandidateEntry[] = [];
  const visit = (index: number): void => {
    if (index === model.positions.length) {
      let c0 = 0;
      let c1 = 0;
      let maxGap = 0;
      let totalGap = 0;
      for (const c of chosen) {
        if (c.readiness === 0) c0++;
        if (c.readiness <= 1) c1++;
        const g = gapOf(c.positionId, c.employeeId);
        if (g > maxGap) maxGap = g;
        totalGap += g;
      }
      const m: Metrics = { c0, c1, c2: chosen.length, maxGap, totalGap };
      if (compare(m, best) < 0) best = m;
      return;
    }
    const p = model.positions[index];
    visit(index + 1); // 岗位空缺
    for (const c of byPosition.get(p.id) ?? []) {
      if (used.has(c.employeeId)) continue;
      used.add(c.employeeId);
      chosen.push(c);
      visit(index + 1);
      chosen.pop();
      used.delete(c.employeeId);
    }
  };
  visit(0);
  return best;
}

/** 确定性伪随机数 (LCG)。 */
const rng = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x80000000;
};

test("暴力枚举对照: 随机小模型下与全局最优完全一致", () => {
  const rand = rng(20261007);
  const pick = (n: number) => Math.floor(rand() * n);
  for (let round = 0; round < 300; round++) {
    const skillCount = 1 + pick(3);
    const positionCount = 1 + pick(4);
    const employeeCount = 1 + pick(5);
    const positions: Position[] = Array.from({ length: positionCount }, (_, i) => ({
      id: `P${i}`,
      requirements: Array.from({ length: 1 + pick(skillCount) }, (_, j) => ({
        skill: `s${j}`,
        required: 1 + pick(5),
        weight: 1 + pick(100),
      })),
    }));
    const employees: Employee[] = Array.from({ length: employeeCount }, (_, i) => {
      const skills: Record<string, number> = {};
      for (let s = 0; s < skillCount; s++) {
        if (rand() < 0.8) skills[`s${s}`] = pick(6);
      }
      return { id: `E${i}`, skills };
    });
    const candidates: CandidateEntry[] = [];
    for (const p of positions) {
      for (const e of employees) {
        if (rand() < 0.5) {
          candidates.push({
            positionId: p.id,
            employeeId: e.id,
            readiness: pick(3) as 0 | 1 | 2,
          });
        }
      }
    }
    const model: SuccessionModel = { positions, employees, candidates };
    const gapOf = (() => {
      const empMap = new Map(employees.map((e) => [e.id, e]));
      const posMap = new Map(positions.map((p) => [p.id, p]));
      return (pid: string, eid: string): number => {
        const p = posMap.get(pid) as Position;
        const e = empMap.get(eid) as Employee;
        let wg = 0;
        let wr = 0;
        for (const req of p.requirements) {
          const shortfall = req.required - (e.skills[req.skill] ?? 0);
          wg += (shortfall > 0 ? shortfall : 0) * req.weight;
          wr += req.required * req.weight;
        }
        return Math.floor((10000 * wg) / wr);
      };
    })();

    const plan = planSuccession(model);
    const expected = bruteForce(model, gapOf);
    const actual: Metrics = {
      c0: plan.c0,
      c1: plan.c1,
      c2: plan.c2,
      maxGap: plan.maxGap,
      totalGap: plan.totalGap,
    };
    assert.deepEqual(actual, expected, `round ${round}: ${JSON.stringify(model)}`);

    // 返回的方案本身必须合法: 名单内、岗位与员工均不重复。
    const seenPositions = new Set<string>();
    const seenEmployees = new Set<string>();
    for (const r of plan.reservations) {
      assert.ok(
        candidates.some((c) => c.positionId === r.positionId && c.employeeId === r.employeeId),
      );
      assert.ok(!seenPositions.has(r.positionId));
      assert.ok(!seenEmployees.has(r.employeeId));
      seenPositions.add(r.positionId);
      seenEmployees.add(r.employeeId);
      assert.equal(r.gap, gapOf(r.positionId, r.employeeId));
    }
  }
});
