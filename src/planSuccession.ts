import { computeGap } from "./gap";
import { MinCostFlow } from "./mcmf";
import type {
  Readiness,
  Reservation,
  SuccessionModel,
  SuccessionPlan,
} from "./types";

interface PairEdge {
  jobIndex: number;
  employeeIndex: number;
  jobId: string;
  employeeId: string;
  readiness: Readiness;
  gap: number;
}

/**
 * Computes a globally optimal reservation plan. Objectives are compared
 * lexicographically: maximize C0, then C1, then C2, then minimize the
 * maximum gap, then minimize the gap sum.
 *
 * Method: the coverage counts (C0, C1, C2) are encoded exactly as a
 * mixed-radix weight per readiness level, so one max-weight matching finds
 * the optimal count vector. The minimal feasible max-gap threshold is then
 * found by binary search over distinct gap values (feasibility = the
 * restricted instance still reaches the optimal weight). Finally a min-cost
 * matching with cost = gap - BIG * levelWeight on edges within the threshold
 * keeps the count vector and max-gap optimal while minimizing the gap sum.
 */
export function planSuccession(model: SuccessionModel): SuccessionPlan {
  const jobIndexById = new Map<string, number>();
  model.jobs.forEach((job, i) => jobIndexById.set(job.id, i));
  const employeeIndexById = new Map<string, number>();
  model.employees.forEach((emp, i) => employeeIndexById.set(emp.id, i));

  // Deduplicate (job, employee) pairs, keeping the best (lowest) readiness.
  const bestReadiness = new Map<number, Readiness>();
  for (const c of model.candidates) {
    const ji = jobIndexById.get(c.jobId);
    const ei = employeeIndexById.get(c.employeeId);
    if (ji === undefined || ei === undefined) continue;
    const key = ji * model.employees.length + ei;
    const prev = bestReadiness.get(key);
    if (prev === undefined || c.readiness < prev) bestReadiness.set(key, c.readiness);
  }

  const pairs: PairEdge[] = [];
  for (const [key, readiness] of bestReadiness) {
    const jobIndex = Math.floor(key / model.employees.length);
    const employeeIndex = key % model.employees.length;
    const job = model.jobs[jobIndex]!;
    const employee = model.employees[employeeIndex]!;
    pairs.push({
      jobIndex,
      employeeIndex,
      jobId: job.id,
      employeeId: employee.id,
      readiness,
      gap: computeGap(job.requirements, employee.skills),
    });
  }

  if (model.employees.length === 0) {
    return {
      reservations: [],
      metrics: { c0: 0, c1: 0, c2: 0, maxGap: 0, totalGap: 0 },
    };
  }

  if (pairs.length === 0) {
    return {
      reservations: [],
      metrics: { c0: 0, c1: 0, c2: 0, maxGap: 0, totalGap: 0 },
    };
  }

  const jobCount = model.jobs.length;
  const employeeCount = model.employees.length;
  const maxMatchingSize = Math.min(jobCount, employeeCount);
  const radix = maxMatchingSize + 1;
  const levelWeight = [radix * radix + radix + 1, radix + 1, 1];

  const runMatching = (
    allowed: PairEdge[],
    edgeCost: (p: PairEdge) => number
  ): { cost: number; chosen: PairEdge[] } => {
    const source = 0;
    const jobBase = 1;
    const empBase = 1 + jobCount;
    const sink = 1 + jobCount + employeeCount;
    const flow = new MinCostFlow(sink + 1);
    for (let j = 0; j < jobCount; j++) flow.addEdge(source, jobBase + j, 1, 0);
    for (let e = 0; e < employeeCount; e++) flow.addEdge(empBase + e, sink, 1, 0);
    const edgeRefs = allowed.map((p) =>
      flow.addEdge(jobBase + p.jobIndex, empBase + p.employeeIndex, 1, edgeCost(p))
    );
    const result = flow.minCostNegativeFlow(source, sink);
    const chosen = allowed.filter((_, i) => edgeRefs[i]!.cap === 0);
    return { cost: result.cost, chosen };
  };

  // Step 1: optimal coverage vector (C0, C1, C2), encoded as a single weight.
  const weightCost = (p: PairEdge): number => -levelWeight[p.readiness]!;
  const optimalWeight = -runMatching(pairs, weightCost).cost;

  // Step 2: smallest max-gap threshold that still reaches the optimal weight.
  const distinctGaps = [...new Set(pairs.map((p) => p.gap))].sort((a, b) => a - b);
  let lo = 0;
  let hi = distinctGaps.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const threshold = distinctGaps[mid]!;
    const weight = -runMatching(pairs.filter((p) => p.gap <= threshold), weightCost).cost;
    if (weight >= optimalWeight) hi = mid;
    else lo = mid + 1;
  }
  const maxGapThreshold = distinctGaps[lo]!;

  // Step 3: within the threshold, minimize the gap sum while preserving the
  // optimal coverage vector (BIG exceeds any achievable gap sum).
  const big = maxMatchingSize * 10000 + 1;
  const feasible = pairs.filter((p) => p.gap <= maxGapThreshold);
  const { chosen } = runMatching(
    feasible,
    (p) => p.gap - big * levelWeight[p.readiness]!
  );

  const reservations: Reservation[] = chosen.map((p) => ({
    jobId: p.jobId,
    employeeId: p.employeeId,
    readiness: p.readiness,
    gap: p.gap,
  }));
  reservations.sort((a, b) =>
    a.jobId === b.jobId ? a.employeeId.localeCompare(b.employeeId) : a.jobId.localeCompare(b.jobId)
  );

  let c0 = 0;
  let c1 = 0;
  let maxGap = 0;
  let totalGap = 0;
  for (const r of reservations) {
    if (r.readiness === 0) c0++;
    if (r.readiness <= 1) c1++;
    if (r.gap > maxGap) maxGap = r.gap;
    totalGap += r.gap;
  }

  return {
    reservations,
    metrics: { c0, c1, c2: reservations.length, maxGap, totalGap },
  };
}
