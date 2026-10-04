import { test } from "node:test";
import * as assert from "node:assert/strict";
import { computeGap, planSuccession } from "../src/index";
import type {
  CandidateEntry,
  PlanMetrics,
  Readiness,
  SuccessionModel,
} from "../src/index";

interface BFPair {
  jobId: string;
  employeeId: string;
  readiness: Readiness;
  gap: number;
}

/** Exhaustive search over all valid reservation sets; returns the best tuple. */
function bruteForceMetrics(model: SuccessionModel): PlanMetrics {
  const bestReadiness = new Map<string, Readiness>();
  for (const c of model.candidates) {
    const key = c.jobId + "|" + c.employeeId;
    const prev = bestReadiness.get(key);
    if (prev === undefined || c.readiness < prev) bestReadiness.set(key, c.readiness);
  }
  const pairs: BFPair[] = [];
  for (const [key, readiness] of bestReadiness) {
    const sep = key.indexOf("|");
    const jobId = key.slice(0, sep);
    const employeeId = key.slice(sep + 1);
    const job = model.jobs.find((j) => j.id === jobId)!;
    const emp = model.employees.find((e) => e.id === employeeId)!;
    pairs.push({
      jobId,
      employeeId,
      readiness,
      gap: computeGap(job.requirements, emp.skills),
    });
  }

  // Lexicographic comparison: higher c0, c1, c2, then lower maxGap, totalGap.
  let best: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  const usedJobs = new Set<string>();
  const usedEmps = new Set<string>();
  let c0 = 0;
  let c1 = 0;
  let c2 = 0;
  let maxGap = 0;
  let totalGap = 0;

  const visit = (i: number): void => {
    const cand: [number, number, number, number, number] = [c0, c1, c2, -maxGap, -totalGap];
    for (let k = 0; k < 5; k++) {
      if (cand[k]! > best[k]!) {
        best = cand;
        break;
      }
      if (cand[k]! < best[k]!) break;
    }
    if (i === pairs.length) return;
    visit(i + 1);
    const p = pairs[i]!;
    if (!usedJobs.has(p.jobId) && !usedEmps.has(p.employeeId)) {
      usedJobs.add(p.jobId);
      usedEmps.add(p.employeeId);
      const pc0 = c0;
      const pc1 = c1;
      const pc2 = c2;
      const pMax = maxGap;
      const pSum = totalGap;
      if (p.readiness === 0) c0++;
      if (p.readiness <= 1) c1++;
      c2++;
      maxGap = Math.max(maxGap, p.gap);
      totalGap += p.gap;
      visit(i + 1);
      c0 = pc0;
      c1 = pc1;
      c2 = pc2;
      maxGap = pMax;
      totalGap = pSum;
      usedJobs.delete(p.jobId);
      usedEmps.delete(p.employeeId);
    }
  };
  visit(0);
  return {
    c0: best[0]!,
    c1: best[1]!,
    c2: best[2]!,
    maxGap: Math.max(0, -best[3]!),
    totalGap: Math.max(0, -best[4]!),
  };
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomModel(rand: () => number): SuccessionModel {
  const pick = (n: number): number => Math.floor(rand() * n);
  const skillCount = 1 + pick(3);
  const skills = Array.from({ length: skillCount }, (_, i) => "s" + i);
  const jobCount = 1 + pick(4);
  const empCount = 1 + pick(4);
  const jobs = Array.from({ length: jobCount }, (_, i) => ({
    id: "j" + i,
    requirements: skills
      .filter(() => rand() < 0.8)
      .map((skill) => ({
        skill,
        required: 1 + pick(5),
        weight: 1 + pick(5),
      }))
      .concat([
        // Guarantee at least one requirement per job.
        { skill: skills[pick(skillCount)]!, required: 1 + pick(5), weight: 1 + pick(5) },
      ]),
  }));
  const employees = Array.from({ length: empCount }, (_, i) => ({
    id: "e" + i,
    skills: Object.fromEntries(
      skills.filter(() => rand() < 0.7).map((s) => [s, pick(6)])
    ),
  }));
  const candidates: CandidateEntry[] = [];
  for (const job of jobs) {
    for (const emp of employees) {
      if (rand() < 0.55) {
        candidates.push({
          jobId: job.id,
          employeeId: emp.id,
          readiness: pick(3) as Readiness,
        });
      }
    }
  }
  return { jobs, employees, candidates };
}

test("matches brute-force optimum on 300 random small models", () => {
  for (let seed = 1; seed <= 300; seed++) {
    const model = randomModel(rng(seed));
    const plan = planSuccession(model);
    const expected = bruteForceMetrics(model);
    assert.deepEqual(
      plan.metrics,
      expected,
      "seed " + seed + " model " + JSON.stringify(model)
    );
    // Structural sanity: distinct jobs and employees, pairs from the input.
    const jobIds = new Set(plan.reservations.map((r) => r.jobId));
    const empIds = new Set(plan.reservations.map((r) => r.employeeId));
    assert.equal(jobIds.size, plan.reservations.length);
    assert.equal(empIds.size, plan.reservations.length);
    for (const r of plan.reservations) {
      assert.ok(
        model.candidates.some(
          (c) => c.jobId === r.jobId && c.employeeId === r.employeeId
        )
      );
    }
  }
});
