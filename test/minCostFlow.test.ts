import { test } from "node:test";
import assert from "node:assert/strict";
import { MinCostFlow } from "../src/minCostFlow";

test("prefers cheaper path", () => {
  // S=0, A=1, B=2, T=3
  const f = new MinCostFlow(4);
  const sa = f.addEdge(0, 1, 1, 5n);
  const sb = f.addEdge(0, 2, 1, 3n);
  f.addEdge(1, 3, 1, 0n);
  f.addEdge(2, 3, 1, 0n);
  assert.equal(f.minCostMaxFlow(0, 3, 1), 1);
  assert.equal(f.flowOn(sa), 0);
  assert.equal(f.flowOn(sb), 1);
});

test("handles negative costs and saturates to maxFlow", () => {
  const f = new MinCostFlow(4);
  f.addEdge(0, 1, 1, -2n);
  f.addEdge(0, 2, 1, 5n);
  f.addEdge(1, 3, 1, 0n);
  f.addEdge(2, 3, 1, 0n);
  assert.equal(f.minCostMaxFlow(0, 3, 2), 2);
});

test("respects capacity limits", () => {
  const f = new MinCostFlow(4);
  f.addEdge(0, 1, 1, 0n);
  f.addEdge(1, 3, 1, 0n);
  assert.equal(f.minCostMaxFlow(0, 3, 5), 1);
});

test("chain with shared capacity forces detour", () => {
  // S=0, M=1, T=2: two units, shared arc cap 1, second must use costly arc
  const f = new MinCostFlow(4);
  f.addEdge(0, 1, 2, 0n);
  f.addEdge(1, 2, 1, 1n);
  f.addEdge(0, 2, 1, 10n);
  assert.equal(f.minCostMaxFlow(0, 2, 2), 2);
});
