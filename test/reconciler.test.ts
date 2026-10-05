import { test } from "node:test";
import assert from "node:assert/strict";
import { createReconciler } from "../src/reconciler";
import { ImportRow, InventoryRecord, RowConclusion } from "../src/types";

function shuffled<T>(items: T[], seed: number): T[] {
  const result = items.slice();
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state;
  };
  for (let i = result.length - 1; i > 0; i--) {
    const j = next() % (i + 1);
    const tmp = result[i] as T;
    result[i] = result[j] as T;
    result[j] = tmp;
  }
  return result;
}

test("evidence priority: one token edge beats any number of lower-level edges", () => {
  const inventory: InventoryRecord[] = [
    { endpointId: "E1", agentToken: "T1", hostname: "h1", ip: "10.0.0.1", site: "s1" },
    { endpointId: "E2", agentToken: "T2", hostname: "h2", ip: "10.0.0.2", site: "s1" },
    { endpointId: "E3", agentToken: "T3", hostname: "h3", ip: "10.0.0.3", site: "s1" },
  ];
  // R1 has three local candidates (token->E1, hostname->E2, ip->E3) but the
  // token edge dominates every alternative, so E1 is the certain match.
  const r1: ImportRow = { agentToken: "T1", hostname: "h2", ip: "10.0.0.3", site: "s1" };
  const r2: ImportRow = { hostname: "h2", ip: "10.0.0.9", site: "s1" };
  const r3: ImportRow = { hostname: "h9", ip: "10.0.0.3", site: "s1" };
  // R4 carries an unknown token: it must not attach to E1 despite identical
  // hostname/ip, so it is a certain addition.
  const r4: ImportRow = { agentToken: "T9", hostname: "h1", ip: "10.0.0.1", site: "s1" };

  const expected: RowConclusion[] = [
    { kind: "matched", possibleEndpointIds: ["E1"], canBeUnmatched: false },
    { kind: "matched", possibleEndpointIds: ["E2"], canBeUnmatched: false },
    { kind: "matched", possibleEndpointIds: ["E3"], canBeUnmatched: false },
    { kind: "new", possibleEndpointIds: [], canBeUnmatched: true },
  ];
  const rows = [r1, r2, r3, r4];

  const reconciler = createReconciler(inventory);
  assert.deepEqual(reconciler.reconcile(rows), expected);
  // The reconciler is reusable and deterministic.
  assert.deepEqual(reconciler.reconcile(rows), expected);

  // Shuffling inventory and import order must not change any conclusion.
  for (const seed of [1, 7, 42, 2024]) {
    const inv = shuffled(inventory, seed);
    const indexed = rows.map((row, i) => ({ row, i }));
    const shuffledRows = shuffled(indexed, seed * 3 + 1);
    const results = createReconciler(inv).reconcile(
      shuffledRows.map((x) => x.row)
    );
    shuffledRows.forEach((x, pos) => {
      assert.deepEqual(
        results[pos],
        expected[x.i],
        `seed=${seed} row=${x.i} changed under shuffling`
      );
    });
  }
});

test("three identical token-less rows competing for two identical endpoints", () => {
  const inventory: InventoryRecord[] = [
    { endpointId: "E1", agentToken: "TA", hostname: "hA", ip: "10.0.0.10", site: "s1" },
    { endpointId: "E2", agentToken: "TB", hostname: "hA", ip: "10.0.0.10", site: "s1" },
  ];
  const row: ImportRow = { hostname: "hA", ip: "10.0.0.10", site: "s1" };
  const rows = [row, { ...row }, { ...row }];

  const results = createReconciler(inventory).reconcile(rows);
  for (const result of results) {
    assert.equal(result.kind, "ambiguous");
    assert.deepEqual(result.possibleEndpointIds, ["E1", "E2"]);
    assert.equal(result.canBeUnmatched, true);
  }
});
