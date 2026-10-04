import { test } from "node:test";
import { deepEqual, equal } from "node:assert/strict";
import { runWorkflow } from "../src/index";
import type {
  HandlerRegistry,
  JsonValue,
  RunRecord,
  WorkflowDef,
} from "../src/index";

// Graph under test (two join levels; the unselected path's descendant F
// also receives another active in-edge):
//
//   A --> B(decision)
//         |true     \false
//         v          v
//         C          D
//         | \        |
//         v  \       v
//         E   \      |
//         |    \     |
//         v     v    v
//         F<----E    D (F joins E and D)
//          \         ^
//           \___G<--/ (G joins C and F)
//
// Edges: A->B, B->C(true), B->D(false), C->E, C->G, D->F, E->F, F->G
function buildDef(): WorkflowDef {
  return {
    nodes: [
      { id: "A", type: "task", handler: "A" },
      { id: "B", type: "decision", handler: "B" },
      { id: "C", type: "task", handler: "C" },
      { id: "D", type: "task", handler: "D" },
      { id: "E", type: "task", handler: "E" },
      { id: "F", type: "task", handler: "F" },
      { id: "G", type: "task", handler: "G" },
    ],
    edges: [
      { from: "A", to: "B" },
      { from: "B", to: "C", when: true },
      { from: "B", to: "D", when: false },
      { from: "C", to: "E" },
      { from: "C", to: "G" },
      { from: "D", to: "F" },
      { from: "E", to: "F" },
      { from: "F", to: "G" },
    ],
  };
}

function makeHandlers(
  picked: boolean,
  log: string[],
  seenInputs: Record<string, JsonValue>,
): HandlerRegistry {
  const record = (id: string, input: JsonValue): void => {
    log.push(id);
    seenInputs[id] = input;
  };
  const num = (v: JsonValue | undefined): number => v as number;
  const obj = (v: JsonValue): Record<string, JsonValue> =>
    v as Record<string, JsonValue>;
  return {
    A: async (input) => {
      record("A", input);
      return 10;
    },
    B: async (input) => {
      record("B", input);
      return picked;
    },
    C: async (input) => {
      record("C", input);
      return 100;
    },
    D: async (input) => {
      record("D", input);
      return 7;
    },
    E: async (input) => {
      record("E", input);
      return num(obj(input).C) + 1;
    },
    F: async (input) => {
      record("F", input);
      const o = obj(input);
      const upstream = o.E !== undefined ? num(o.E) : num(o.D);
      return upstream * 2;
    },
    G: async (input) => {
      record("G", input);
      return Object.values(obj(input)).reduce<number>(
        (acc, v) => acc + num(v),
        0,
      );
    },
  };
}

function recordOf(records: RunRecord[], nodeId: string): RunRecord {
  const rec = records.find((r) => r.nodeId === nodeId && r.loopId === undefined);
  if (!rec) throw new Error(`missing record for ${nodeId}`);
  return rec;
}

test("true branch: two-level join, unselected path descendant runs via other active edge", async () => {
  const log: string[] = [];
  const seenInputs: Record<string, JsonValue> = {};
  const result = await runWorkflow(
    buildDef(),
    makeHandlers(true, log, seenInputs),
    null,
    5000,
  );

  equal(result.status, "success");
  // Serial-computed expected outputs.
  deepEqual(result.output, {
    A: 10,
    B: true,
    C: 100,
    E: 101,
    F: 202,
    G: 302,
  });
  // Strict dependency order: joins fire neither early nor late.
  deepEqual(log, ["A", "B", "C", "E", "F", "G"]);
  // D is on the unselected path: skipped, no output.
  equal(recordOf(result.records, "D").status, "skipped");
  equal(recordOf(result.records, "D").output, undefined);
  for (const id of ["A", "B", "C", "E", "F", "G"]) {
    equal(recordOf(result.records, id).status, "success", id);
  }
  // F executes with only the active in-edge's source output.
  deepEqual(seenInputs.F, { E: 101 });
  // G joins C and F exactly once, with both outputs.
  deepEqual(seenInputs.G, { C: 100, F: 202 });
});

test("false branch: mirror image, join not wrongly skipped", async () => {
  const log: string[] = [];
  const seenInputs: Record<string, JsonValue> = {};
  const result = await runWorkflow(
    buildDef(),
    makeHandlers(false, log, seenInputs),
    null,
    5000,
  );

  equal(result.status, "success");
  deepEqual(result.output, {
    A: 10,
    B: false,
    D: 7,
    F: 14,
    G: 14,
  });
  deepEqual(log, ["A", "B", "D", "F", "G"]);
  equal(recordOf(result.records, "C").status, "skipped");
  equal(recordOf(result.records, "E").status, "skipped");
  deepEqual(seenInputs.F, { D: 7 });
  deepEqual(seenInputs.G, { F: 14 });
});
