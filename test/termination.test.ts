import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { runWorkflow } from "../src/index";
import type { HandlerRegistry, JsonValue, WorkflowDef } from "../src/index";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Chain: A -> B -> C, plus D depending on C.
function chainDef(): WorkflowDef {
  return {
    nodes: [
      { id: "A", type: "task", handler: "A" },
      { id: "B", type: "task", handler: "B" },
      { id: "C", type: "task", handler: "C" },
      { id: "D", type: "task", handler: "D" },
    ],
    edges: [
      { from: "A", to: "B" },
      { from: "B", to: "C" },
      { from: "C", to: "D" },
    ],
  };
}

test("first handler failure ends the run and cancels unfinished instances", async () => {
  const started: string[] = [];
  const handlers: HandlerRegistry = {
    A: async () => {
      started.push("A");
      return 1;
    },
    B: async () => {
      started.push("B");
      throw new Error("boom");
    },
    C: async () => {
      started.push("C");
      return 3;
    },
    D: async () => {
      started.push("D");
      return 4;
    },
  };
  const result = await runWorkflow(chainDef(), handlers, null, 5000);

  equal(result.status, "failed");
  // No new instances start after the failure.
  deepEqual(started, ["A", "B"]);
  const byId = new Map(result.records.map((r) => [r.nodeId, r]));
  equal(byId.get("A")?.status, "success");
  equal(byId.get("A")?.output, 1);
  // The failed instance never reached a terminal state: cancelled.
  equal(byId.get("B")?.status, "cancelled");
  equal(byId.get("C")?.status, "cancelled");
  equal(byId.get("D")?.status, "cancelled");
});

test("timeout marks the run and ignores late success and late failure", async () => {
  let lateSettled = false;
  const handlers: HandlerRegistry = {
    A: async () => 1,
    B: async () => {
      // Resolves long after the deadline; must not change records.
      await sleep(60);
      lateSettled = true;
      return 2;
    },
    C: async () => 3,
    D: async () => 4,
  };
  const result = await runWorkflow(chainDef(), handlers, null, 20);

  equal(result.status, "timeout");
  const byId = new Map(result.records.map((r) => [r.nodeId, r]));
  equal(byId.get("A")?.status, "success");
  equal(byId.get("B")?.status, "cancelled");
  equal(byId.get("C")?.status, "cancelled");
  equal(byId.get("D")?.status, "cancelled");

  // Wait for the late handler to finish; records must stay untouched.
  await sleep(100);
  ok(lateSettled);
  const byIdAfter = new Map(result.records.map((r) => [r.nodeId, r]));
  equal(byIdAfter.get("B")?.status, "cancelled");
});

test("late rejection after timeout does not crash the process", async () => {
  const handlers: HandlerRegistry = {
    A: async () => 1,
    B: async () => {
      await sleep(50);
      throw new Error("late boom");
    },
    C: async () => 3,
    D: async () => 4,
  };
  const result = await runWorkflow(chainDef(), handlers, null, 20);
  equal(result.status, "timeout");
  // If the late rejection were unhandled, the test process would fail here.
  await sleep(80);
});

test("timeout covers loop iterations; unfinished iteration instances cancel", async () => {
  const def: WorkflowDef = {
    nodes: [
      { id: "S", type: "task", handler: "S" },
      {
        id: "L",
        type: "loop",
        body: {
          nodes: [
            { id: "W", type: "task", handler: "W" },
            { id: "X", type: "task", handler: "X" },
          ],
          edges: [{ from: "W", to: "X" }],
        },
      },
    ],
    edges: [{ from: "S", to: "L" }],
  };
  const handlers: HandlerRegistry = {
    S: async () => [1, 2, 3],
    W: async (input: JsonValue) => {
      // Iteration with element 2 hangs past the deadline.
      if ((input as number) === 2) await sleep(200);
      return input;
    },
    X: async (input: JsonValue) => input,
  };
  const result = await runWorkflow(def, handlers, null, 50);

  equal(result.status, "timeout");
  equal(result.records.find((r) => r.nodeId === "S")?.status, "success");
  equal(result.records.find((r) => r.nodeId === "L")?.status, "cancelled");
  // Iteration 1 (element 2) never finished: its instances are cancelled.
  const iter1 = result.records.filter((r) => r.loopId === "L" && r.iteration === 1);
  equal(iter1.length, 2);
  for (const rec of iter1) equal(rec.status, "cancelled");
  // A finished iteration keeps its terminal records.
  const iter0 = result.records.filter((r) => r.loopId === "L" && r.iteration === 0);
  equal(iter0.find((r) => r.nodeId === "W")?.status, "success");
  equal(iter0.find((r) => r.nodeId === "X")?.status, "success");
});
