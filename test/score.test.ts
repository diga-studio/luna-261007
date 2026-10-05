import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scoreResume } from "../src/index.js";
import type { Job, MatchResult, ResumeEntry } from "../src/index.js";

/** Every allocation must be backed by resume evidence. */
function assertExplanationConsistent(
  result: MatchResult,
  entries: ResumeEntry[],
  baseline: string,
): void {
  const seenMonths = new Set<string>();
  let sum = 0;
  for (const alloc of result.allocations) {
    assert.ok(!seenMonths.has(alloc.month), `month reused: ${alloc.month}`);
    seenMonths.add(alloc.month);
    const covered = entries.some(
      (e) =>
        e.startMonth <= alloc.month &&
        alloc.month <= e.endMonth &&
        e.skills.includes(alloc.skill),
    );
    assert.ok(covered, `month ${alloc.month} lacks evidence for ${alloc.skill}`);
    const [year, mon] = alloc.month.split("-").map(Number);
    const [by, bm] = baseline.split("-").map(Number);
    const age = by * 12 + (bm - 1) - (year * 12 + (mon - 1));
    assert.ok(age >= 0 && age < 60, `month ${alloc.month} outside window`);
    assert.equal(alloc.points, age < 12 ? 2 : 1);
    sum += alloc.weightedScore;
  }
  assert.equal(sum, result.numerator);
  assert.ok(Math.abs(result.score - (100 * sum) / result.denominator) < 1e-9);
}

describe("scoreResume", () => {
  it("allocates the shared recent month to the skill only it can prove", () => {
    const job: Job = {
      requirements: [
        { skill: "a", targetMonths: 1, weight: 1 },
        { skill: "b", targetMonths: 1, weight: 1 },
      ],
    };
    const entries: ResumeEntry[] = [
      { startMonth: "2025-06", endMonth: "2025-06", skills: ["a", "b"] },
      { startMonth: "2022-01", endMonth: "2022-01", skills: ["a"] },
    ];
    const result = scoreResume(job, entries, "2025-06");
    assert.equal(result.denominator, 4);
    assert.equal(result.numerator, 3);
    assert.equal(result.score, 75);
    assertExplanationConsistent(result, entries, "2025-06");
  });

  it("is unchanged by duplicate records or split entries", () => {
    const job: Job = {
      requirements: [
        { skill: "a", targetMonths: 8, weight: 2 },
        { skill: "b", targetMonths: 4, weight: 1 },
      ],
    };
    const whole: ResumeEntry[] = [
      { startMonth: "2024-01", endMonth: "2024-12", skills: ["a", "b"] },
    ];
    const fragmented: ResumeEntry[] = [
      { startMonth: "2024-01", endMonth: "2024-12", skills: ["a", "b"] },
      { startMonth: "2024-01", endMonth: "2024-12", skills: ["a", "b"] },
      { startMonth: "2024-01", endMonth: "2024-06", skills: ["a"] },
      { startMonth: "2024-06", endMonth: "2024-12", skills: ["b"] },
      { startMonth: "2024-03", endMonth: "2024-09", skills: ["a", "b", "a"] },
    ];
    const r1 = scoreResume(job, whole, "2025-06");
    const r2 = scoreResume(job, fragmented, "2025-06");
    assert.equal(r2.score, r1.score);
    assert.equal(r2.numerator, r1.numerator);
    assertExplanationConsistent(r2, fragmented, "2025-06");
  });

  it("finds the optimum a greedy pass would miss", () => {
    const job: Job = {
      requirements: [
        { skill: "s1", targetMonths: 1, weight: 3 },
        { skill: "s2", targetMonths: 1, weight: 2 },
      ],
    };
    const entries: ResumeEntry[] = [
      { startMonth: "2025-06", endMonth: "2025-06", skills: ["s1", "s2"] },
      { startMonth: "2025-05", endMonth: "2025-05", skills: ["s1"] },
    ];
    const result = scoreResume(job, entries, "2025-06");
    // Optimum: 2025-06 -> s2 (2*2), 2025-05 -> s1 (2*3) = 10, not 6.
    assert.equal(result.numerator, 10);
    assert.equal(result.score, 100);
    assertExplanationConsistent(result, entries, "2025-06");
  });

  it("caps each skill at its target months", () => {
    const job: Job = {
      requirements: [{ skill: "a", targetMonths: 2, weight: 1 }],
    };
    const entries: ResumeEntry[] = [
      { startMonth: "2025-01", endMonth: "2025-06", skills: ["a"] },
    ];
    const result = scoreResume(job, entries, "2025-06");
    assert.equal(result.allocations.length, 2);
    assert.equal(result.numerator, 4);
    assert.equal(result.score, 100);
  });

  it("ignores evidence outside the 60-month window", () => {
    const job: Job = {
      requirements: [{ skill: "a", targetMonths: 1, weight: 1 }],
    };
    const entries: ResumeEntry[] = [
      { startMonth: "2019-01", endMonth: "2020-06", skills: ["a"] },
    ];
    const result = scoreResume(job, entries, "2025-06");
    assert.equal(result.numerator, 0);
    assert.equal(result.score, 0);
    assert.equal(result.allocations.length, 0);
  });

  it("counts both boundary months of an entry", () => {
    const job: Job = {
      requirements: [{ skill: "a", targetMonths: 2, weight: 1 }],
    };
    const entries: ResumeEntry[] = [
      { startMonth: "2025-05", endMonth: "2025-06", skills: ["a"] },
    ];
    const result = scoreResume(job, entries, "2025-06");
    assert.equal(result.allocations.length, 2);
    assert.equal(result.score, 100);
  });
});
