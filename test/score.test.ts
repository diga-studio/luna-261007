import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreCandidate, type Job, type ResumeEntry, type ScoreResult } from "../src/index.js";

/** 校验分配说明：月份有履历支持、不重复、合计能还原评分。 */
function assertExplanationConsistent(
  result: ScoreResult,
  job: Job,
  entries: ResumeEntry[],
  baselineMonth: string,
): void {
  const seen = new Set<string>();
  let numerator = 0;
  const weightBySkill = new Map(job.requirements.map((r) => [r.skill, r.weight]));
  const baseline = parseInt(baselineMonth.slice(0, 4), 10) * 12 + parseInt(baselineMonth.slice(5, 7), 10) - 1;
  for (const allocation of result.allocations) {
    assert.ok(!seen.has(allocation.month), `month reused: ${allocation.month}`);
    seen.add(allocation.month);
    const supported = entries.some((entry) => {
      return entry.startMonth <= allocation.month
        && allocation.month <= entry.endMonth
        && entry.skills.includes(allocation.skill);
    });
    assert.ok(supported, `month ${allocation.month} lacks resume support for ${allocation.skill}`);
    const monthIndex = parseInt(allocation.month.slice(0, 4), 10) * 12 + parseInt(allocation.month.slice(5, 7), 10) - 1;
    assert.ok(baseline - 59 <= monthIndex && monthIndex <= baseline, `month out of window: ${allocation.month}`);
    assert.equal(allocation.points, monthIndex >= baseline - 11 ? 2 : 1);
    assert.equal(allocation.weightedScore, allocation.points * weightBySkill.get(allocation.skill)!);
    numerator += allocation.weightedScore;
  }
  assert.equal(numerator, result.numerator);
  const denominator = 2 * job.requirements.reduce((sum, r) => sum + r.targetMonths * r.weight, 0);
  assert.equal(denominator, result.denominator);
  assert.ok(Math.abs(result.score - (100 * result.numerator) / result.denominator) < 1e-9);
}

test("一个近期月份同时覆盖两项技能时，最优分为 75", () => {
  const job: Job = {
    requirements: [
      { skill: "A", targetMonths: 1, weight: 1 },
      { skill: "B", targetMonths: 1, weight: 1 },
    ],
  };
  const entries: ResumeEntry[] = [
    { startMonth: "2025-06", endMonth: "2025-06", skills: ["A", "B"] },
    { startMonth: "2024-01", endMonth: "2024-01", skills: ["A"] },
  ];
  const result = scoreCandidate(job, entries, "2025-06");
  // 近期月分给 B 得 2 点，较早月分给 A 得 1 点；分子 3，分母 4。
  assert.equal(result.numerator, 3);
  assert.equal(result.denominator, 4);
  assert.equal(result.score, 75);
  assertExplanationConsistent(result, job, entries, "2025-06");
});

test("重复记录不改变分数", () => {
  const job: Job = {
    requirements: [
      { skill: "A", targetMonths: 3, weight: 2 },
      { skill: "B", targetMonths: 2, weight: 1 },
    ],
  };
  const entries: ResumeEntry[] = [
    { startMonth: "2025-01", endMonth: "2025-06", skills: ["A", "B"] },
    { startMonth: "2024-06", endMonth: "2024-12", skills: ["A"] },
  ];
  const duplicated: ResumeEntry[] = [
    ...entries,
    { startMonth: "2025-01", endMonth: "2025-06", skills: ["A", "B"] },
    { startMonth: "2025-03", endMonth: "2025-04", skills: ["A", "B"] },
    { startMonth: "2024-09", endMonth: "2024-10", skills: ["A"] },
  ];
  const base = scoreCandidate(job, entries, "2025-06");
  const withDuplicates = scoreCandidate(job, duplicated, "2025-06");
  assert.equal(withDuplicates.score, base.score);
  assert.equal(withDuplicates.numerator, base.numerator);
  assertExplanationConsistent(withDuplicates, job, duplicated, "2025-06");
});

test("拆分连续履历不改变分数", () => {
  const job: Job = {
    requirements: [
      { skill: "A", targetMonths: 4, weight: 2 },
      { skill: "B", targetMonths: 3, weight: 1 },
    ],
  };
  const whole: ResumeEntry[] = [
    { startMonth: "2024-10", endMonth: "2025-06", skills: ["A", "B"] },
  ];
  const split: ResumeEntry[] = [
    { startMonth: "2024-10", endMonth: "2024-12", skills: ["A", "B"] },
    { startMonth: "2025-01", endMonth: "2025-03", skills: ["A", "B"] },
    { startMonth: "2025-04", endMonth: "2025-06", skills: ["A", "B"] },
  ];
  const base = scoreCandidate(job, whole, "2025-06");
  const fromSplit = scoreCandidate(job, split, "2025-06");
  assert.equal(fromSplit.score, base.score);
  assert.equal(fromSplit.numerator, base.numerator);
  assertExplanationConsistent(fromSplit, job, split, "2025-06");
});

test("每项技能所得月数不超过目标月数", () => {
  const job: Job = {
    requirements: [{ skill: "A", targetMonths: 2, weight: 1 }],
  };
  const entries: ResumeEntry[] = [
    { startMonth: "2025-01", endMonth: "2025-06", skills: ["A"] },
  ];
  const result = scoreCandidate(job, entries, "2025-06");
  // 目标 2 个月，每月 2 点：分子 4，分母 2*2*1=4，满分 100。
  assert.equal(result.allocations.length, 2);
  assert.equal(result.score, 100);
  assertExplanationConsistent(result, job, entries, "2025-06");
});

test("只使用含基准月份在内的最近 60 个自然月", () => {
  const job: Job = {
    requirements: [{ skill: "A", targetMonths: 100, weight: 1 }],
  };
  // 窗口为 2020-07..2025-06；2020-06 及更早的月份必须被忽略。
  const entries: ResumeEntry[] = [
    { startMonth: "2019-01", endMonth: "2025-06", skills: ["A"] },
  ];
  const result = scoreCandidate(job, entries, "2025-06");
  assert.equal(result.allocations.length, 60);
  assert.equal(result.allocations[0]!.month, "2020-07");
  assert.equal(result.allocations.at(-1)!.month, "2025-06");
  // 12 个月 * 2 点 + 48 个月 * 1 点 = 72；分母 2*100*1=200。
  assert.equal(result.numerator, 72);
  assert.equal(result.score, 36);
  assertExplanationConsistent(result, job, entries, "2025-06");
});

test("高权重技能优先获得近期月份", () => {
  const job: Job = {
    requirements: [
      { skill: "A", targetMonths: 1, weight: 3 },
      { skill: "B", targetMonths: 1, weight: 1 },
    ],
  };
  // 近期月同时覆盖 A、B；应分给权重更高的 A。
  const entries: ResumeEntry[] = [
    { startMonth: "2025-06", endMonth: "2025-06", skills: ["A", "B"] },
    { startMonth: "2025-05", endMonth: "2025-05", skills: ["B"] },
  ];
  const result = scoreCandidate(job, entries, "2025-06");
  // 2025-06 -> A (2*3=6)，2025-05 -> B (2*1=2)；分子 8，分母 2*(3+1)=8。
  assert.equal(result.score, 100);
  const june = result.allocations.find((a) => a.month === "2025-06");
  assert.equal(june!.skill, "A");
  assertExplanationConsistent(result, job, entries, "2025-06");
});

test("与岗位无关的技能和窗口外履历不产生分配", () => {
  const job: Job = {
    requirements: [{ skill: "A", targetMonths: 1, weight: 1 }],
  };
  const entries: ResumeEntry[] = [
    { startMonth: "2025-06", endMonth: "2025-06", skills: ["X", "Y"] },
    { startMonth: "2010-01", endMonth: "2010-12", skills: ["A"] },
  ];
  const result = scoreCandidate(job, entries, "2025-06");
  assert.equal(result.score, 0);
  assert.equal(result.allocations.length, 0);
});

test("基准月份之后的履历不计入", () => {
  const job: Job = {
    requirements: [{ skill: "A", targetMonths: 12, weight: 1 }],
  };
  const entries: ResumeEntry[] = [
    { startMonth: "2025-01", endMonth: "2026-03", skills: ["A"] },
  ];
  const result = scoreCandidate(job, entries, "2025-06");
  assert.equal(result.allocations.length, 6);
  assert.equal(result.allocations.at(-1)!.month, "2025-06");
  assertExplanationConsistent(result, job, entries, "2025-06");
});
