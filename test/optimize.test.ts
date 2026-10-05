import { test } from "node:test";
import assert from "node:assert/strict";
import { optimalAssignment, type AssignmentMonth } from "../src/optimize.js";

/** 穷举所有合法分配求最大权，作为对照。 */
function bruteForce(months: AssignmentMonth[], capacities: number[], weights: number[]): number {
  let best = 0;
  const used = new Array<number>(capacities.length).fill(0);
  const visit = (i: number, acc: number): void => {
    if (i === months.length) {
      best = Math.max(best, acc);
      return;
    }
    visit(i + 1, acc); // 该月不分配
    const month = months[i]!;
    for (const skillIndex of month.skillOptions) {
      if (used[skillIndex]! < capacities[skillIndex]!) {
        used[skillIndex]! += 1;
        visit(i + 1, acc + month.points * weights[skillIndex]!);
        used[skillIndex]! -= 1;
      }
    }
  };
  visit(0, 0);
  return best;
}

function totalWeight(
  months: AssignmentMonth[],
  edges: { monthPos: number; skillIndex: number }[],
  weights: number[],
): number {
  return edges.reduce((sum, edge) => sum + months[edge.monthPos]!.points * weights[edge.skillIndex]!, 0);
}

test("随机小规模案例下与穷举最优解一致", () => {
  let seed = 42;
  const random = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let trial = 0; trial < 300; trial += 1) {
    const skillCount = 1 + Math.floor(random() * 3);
    const monthCount = 1 + Math.floor(random() * 8);
    const capacities = Array.from({ length: skillCount }, () => 1 + Math.floor(random() * 4));
    const weights = Array.from({ length: skillCount }, () => 1 + Math.floor(random() * 5));
    const months: AssignmentMonth[] = Array.from({ length: monthCount }, (_, i) => ({
      monthIndex: i,
      points: random() < 0.3 ? 2 : 1,
      skillOptions: Array.from({ length: skillCount }, (_, j) => j).filter(() => random() < 0.5),
    }));
    const edges = optimalAssignment(months, capacities, weights);
    // 校验分配本身合法：月份不重复、技能不超额。
    assert.equal(new Set(edges.map((e) => e.monthPos)).size, edges.length);
    const perSkill = new Map<number, number>();
    for (const edge of edges) {
      perSkill.set(edge.skillIndex, (perSkill.get(edge.skillIndex) ?? 0) + 1);
      assert.ok(months[edge.monthPos]!.skillOptions.includes(edge.skillIndex));
    }
    for (const [skillIndex, count] of perSkill) {
      assert.ok(count <= capacities[skillIndex]!);
    }
    assert.ok(
      Math.abs(totalWeight(months, edges, weights) - bruteForce(months, capacities, weights)) < 1e-9,
      `trial ${trial} mismatch`,
    );
  }
});
