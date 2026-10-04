import { test } from "node:test";
import { deepEqual, equal } from "node:assert/strict";
import { runWorkflow } from "../src/index";
import type {
  HandlerRegistry,
  JsonValue,
  RunRecord,
  WorkflowDef,
} from "../src/index";

// Outer graph: S -> L(loop) -> T
// Loop body: P(decision on element) --true--> M
//                                \--false--> N
function buildDef(): WorkflowDef {
  return {
    nodes: [
      { id: "S", type: "task", handler: "S" },
      {
        id: "L",
        type: "loop",
        body: {
          nodes: [
            { id: "P", type: "decision", handler: "P" },
            { id: "M", type: "task", handler: "M" },
            { id: "N", type: "task", handler: "N" },
          ],
          edges: [
            { from: "P", to: "M", when: true },
            { from: "P", to: "N", when: false },
          ],
        },
      },
      { id: "T", type: "task", handler: "T" },
    ],
    edges: [
      { from: "S", to: "L" },
      { from: "L", to: "T" },
    ],
  };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function makeHandlers(
  source: JsonValue[],
  seen: { P: JsonValue[]; M: JsonValue[]; N: JsonValue[] },
): HandlerRegistry {
  return {
    S: async () => source,
    P: async (input) => {
      seen.P.push(input);
      // Resolve iterations out of order: small elements finish later.
      await sleep((input as number) === 1 ? 30 : 0);
      return (input as number) % 2 === 0;
    },
    M: async (input) => {
      seen.M.push(input);
      return input;
    },
    N: async (input) => {
      seen.N.push(input);
      return input;
    },
    T: async (input) => input,
  };
}

function bodyRecords(
  records: RunRecord[],
  iteration: number,
): RunRecord[] {
  return records.filter(
    (r) => r.loopId === "L" && r.iteration === iteration,
  );
}

test("loop: iterations pick different branches, stay isolated, keep input order", async () => {
  const seen = { P: [] as JsonValue[], M: [] as JsonValue[], N: [] as JsonValue[] };
  const result = await runWorkflow(
    buildDef(),
    makeHandlers([1, 2, 3, 4], seen),
    null,
    5000,
  );

  equal(result.status, "success");

  const expectedIterations: JsonValue[] = [
    { P: false, N: { P: false } },
    { P: true, M: { P: true } },
    { P: false, N: { P: false } },
    { P: true, M: { P: true } },
  ];
  // Loop output preserves input order despite out-of-order completion.
  const loopRec = result.records.find((r) => r.nodeId === "L");
  equal(loopRec?.status, "success");
  deepEqual(loopRec?.output, expectedIterations);
  deepEqual(result.output.L, expectedIterations);
  deepEqual(result.output.T, { L: expectedIterations });

  // Body roots received exactly their own element (no cross-iteration data).
  deepEqual([...seen.P].sort((a, b) => (a as number) - (b as number)), [1, 2, 3, 4]);
  // Branch handlers saw only the decision output of their own iteration.
  for (const input of seen.M) deepEqual(input, { P: true });
  for (const input of seen.N) deepEqual(input, { P: false });
  equal(seen.M.length, 2);
  equal(seen.N.length, 2);

  // Records are kept per iteration; same node ids never overwrite.
  const all = result.records.filter((r) => r.loopId === "L");
  equal(all.length, 12);
  for (let i = 0; i < 4; i += 1) {
    const recs = bodyRecords(result.records, i);
    equal(recs.length, 3);
    const byId = new Map(recs.map((r) => [r.nodeId, r]));
    equal(byId.get("P")?.status, "success");
    if (i % 2 === 0) {
      equal(byId.get("M")?.status, "skipped");
      equal(byId.get("N")?.status, "success");
      equal(byId.get("M")?.output, undefined);
    } else {
      equal(byId.get("M")?.status, "success");
      equal(byId.get("N")?.status, "skipped");
    }
  }
});

test("loop: empty array succeeds immediately with empty output", async () => {
  const seen = { P: [] as JsonValue[], M: [] as JsonValue[], N: [] as JsonValue[] };
  const result = await runWorkflow(
    buildDef(),
    makeHandlers([], seen),
    null,
    5000,
  );

  equal(result.status, "success");
  deepEqual(result.output.L, []);
  deepEqual(result.output.T, { L: [] });
  equal(seen.P.length, 0);
  equal(result.records.filter((r) => r.loopId === "L").length, 0);
});
