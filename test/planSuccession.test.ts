import { test } from "node:test";
import * as assert from "node:assert/strict";
import { computeGap, planSuccession } from "../src/index";
import type { SuccessionPlan } from "../src/index";

function pairSet(plan: SuccessionPlan): string[] {
  return plan.reservations.map((r) => r.jobId + "->" + r.employeeId).sort();
}

test("gap is a floored basis-point ratio, missing skills count as 0", () => {
  assert.equal(computeGap([{ skill: "s", required: 3, weight: 1 }], { s: 1 }), 6666);
  assert.equal(computeGap([{ skill: "s", required: 3, weight: 1 }], {}), 10000);
  assert.equal(computeGap([{ skill: "s", required: 3, weight: 1 }], { s: 3 }), 0);
  assert.equal(
    computeGap(
      [
        { skill: "a", required: 5, weight: 3 },
        { skill: "b", required: 2, weight: 1 },
      ],
      { a: 5, b: 0 }
    ),
    1176
  );
});

test("contention chain: local per-job optimum must not block other jobs", () => {
  // Chain j1 -> j2 -> j3 sharing employees e2, e3. Taking the locally best
  // gap-0 edge for j1 (e2) cascades and leaves j3 empty (C0 = 2). The global
  // optimum reserves everyone (C0 = 3) at the price of one gap-4000 edge.
  const plan = planSuccession({
    jobs: [
      { id: "j1", requirements: [{ skill: "s1", required: 5, weight: 1 }] },
      { id: "j2", requirements: [{ skill: "s2", required: 5, weight: 1 }] },
      { id: "j3", requirements: [{ skill: "s3", required: 5, weight: 1 }] },
    ],
    employees: [
      { id: "e1", skills: { s1: 3 } },
      { id: "e2", skills: { s1: 5, s2: 5 } },
      { id: "e3", skills: { s2: 3, s3: 5 } },
    ],
    candidates: [
      { jobId: "j1", employeeId: "e1", readiness: 0 },
      { jobId: "j1", employeeId: "e2", readiness: 0 },
      { jobId: "j2", employeeId: "e2", readiness: 0 },
      { jobId: "j2", employeeId: "e3", readiness: 0 },
      { jobId: "j3", employeeId: "e3", readiness: 0 },
    ],
  });
  assert.equal(plan.metrics.c0, 3);
  assert.equal(plan.metrics.c1, 3);
  assert.equal(plan.metrics.c2, 3);
  assert.deepEqual(pairSet(plan), ["j1->e1", "j2->e2", "j3->e3"]);
  assert.equal(plan.metrics.maxGap, 4000);
  assert.equal(plan.metrics.totalGap, 4000);
});

test("current coverage is never traded for more future coverage", () => {
  // Plan A: j1->e1 (ready now) + j3->e2 (ready in 2y)  => C0=1, C2=2.
  // Plan B: j2->e1 (2y) + j3->e2 (2y), j1 vacant       => C0=0, C2=3.
  // A solver maximizing total coverage would pick B; the spec demands A.
  const plan = planSuccession({
    jobs: [
      { id: "j1", requirements: [{ skill: "a", required: 1, weight: 1 }] },
      { id: "j2", requirements: [{ skill: "b", required: 1, weight: 1 }] },
      { id: "j3", requirements: [{ skill: "c", required: 1, weight: 1 }] },
    ],
    employees: [
      { id: "e1", skills: { a: 1, b: 1 } },
      { id: "e2", skills: { c: 1 } },
    ],
    candidates: [
      { jobId: "j1", employeeId: "e1", readiness: 0 },
      { jobId: "j2", employeeId: "e1", readiness: 2 },
      { jobId: "j3", employeeId: "e2", readiness: 2 },
    ],
  });
  assert.equal(plan.metrics.c0, 1);
  assert.equal(plan.metrics.c1, 1);
  assert.equal(plan.metrics.c2, 2);
  assert.deepEqual(pairSet(plan), ["j1->e1", "j3->e2"]);
});

test("equal coverage: smaller max gap wins over smaller gap sum", () => {
  // Plan A: gaps {5000, 5000} -> max 5000, sum 10000.
  // Plan B: gaps {0, 6000}    -> max 6000, sum 6000.
  // Identical (C0, C1, C2); the worst protected job decides, so A wins
  // even though its average gap is worse.
  const plan = planSuccession({
    jobs: [
      { id: "j1", requirements: [{ skill: "x", required: 2, weight: 1 }] },
      {
        id: "j2",
        requirements: [
          { skill: "y1", required: 5, weight: 1 },
          { skill: "y2", required: 5, weight: 1 },
        ],
      },
    ],
    employees: [
      { id: "e1", skills: { x: 1, y1: 2, y2: 2 } },
      { id: "e2", skills: { x: 5, y1: 0, y2: 5 } },
    ],
    candidates: [
      { jobId: "j1", employeeId: "e1", readiness: 0 },
      { jobId: "j1", employeeId: "e2", readiness: 0 },
      { jobId: "j2", employeeId: "e1", readiness: 0 },
      { jobId: "j2", employeeId: "e2", readiness: 0 },
    ],
  });
  assert.equal(plan.metrics.c2, 2);
  assert.equal(plan.metrics.maxGap, 5000);
  assert.equal(plan.metrics.totalGap, 10000);
  assert.deepEqual(pairSet(plan), ["j1->e1", "j2->e2"]);
});

test("readiness tiers: C1 is optimized before C2", () => {
  // j1 can take e1 now; j2 can take e1 within a year or e2 in two years.
  // C0=1 forces j1->e1; then C1 prefers j2->e2? No: j2->e1 is impossible
  // (e1 taken), so j2->e2 (readiness 2) gives C1=1, C2=2.
  const plan = planSuccession({
    jobs: [
      { id: "j1", requirements: [{ skill: "a", required: 1, weight: 1 }] },
      { id: "j2", requirements: [{ skill: "b", required: 1, weight: 1 }] },
    ],
    employees: [
      { id: "e1", skills: { a: 1, b: 1 } },
      { id: "e2", skills: { b: 1 } },
    ],
    candidates: [
      { jobId: "j1", employeeId: "e1", readiness: 0 },
      { jobId: "j2", employeeId: "e1", readiness: 1 },
      { jobId: "j2", employeeId: "e2", readiness: 2 },
    ],
  });
  assert.equal(plan.metrics.c0, 1);
  assert.equal(plan.metrics.c1, 1);
  assert.equal(plan.metrics.c2, 2);
  assert.deepEqual(pairSet(plan), ["j1->e1", "j2->e2"]);
});

test("empty candidate lists yield an empty plan with zero metrics", () => {
  const plan = planSuccession({
    jobs: [{ id: "j1", requirements: [{ skill: "a", required: 1, weight: 1 }] }],
    employees: [{ id: "e1", skills: { a: 5 } }],
    candidates: [],
  });
  assert.deepEqual(plan.reservations, []);
  assert.deepEqual(plan.metrics, { c0: 0, c1: 0, c2: 0, maxGap: 0, totalGap: 0 });
});

test("each job and each employee is reserved at most once", () => {
  const plan = planSuccession({
    jobs: [
      { id: "j1", requirements: [{ skill: "a", required: 1, weight: 1 }] },
      { id: "j2", requirements: [{ skill: "a", required: 1, weight: 1 }] },
    ],
    employees: [{ id: "e1", skills: { a: 1 } }],
    candidates: [
      { jobId: "j1", employeeId: "e1", readiness: 0 },
      { jobId: "j2", employeeId: "e1", readiness: 0 },
    ],
  });
  assert.equal(plan.metrics.c2, 1);
  assert.equal(plan.reservations.length, 1);
});
