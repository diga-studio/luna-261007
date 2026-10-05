import { test } from "node:test";
import assert from "node:assert/strict";

import { createReconciler } from "../src/reconciler.js";
import type { ImportRow, InventoryRecord, RowReconciliation } from "../src/types.js";

function inv(
  endpointId: string,
  agentToken: string,
  hostname: string,
  ip: string,
  site: string,
): InventoryRecord {
  return { endpointId, agentToken, hostname, ip, site };
}

function row(agentToken: string | undefined, hostname: string, ip: string, site: string): ImportRow {
  return agentToken === undefined
    ? { hostname, ip, site }
    : { agentToken, hostname, ip, site };
}

/** Deterministic permutations used to shuffle inventory / row order. */
function permute<T>(items: readonly T[], order: readonly number[]): T[] {
  return order.map((i) => {
    const value = items[i];
    assert.ok(value !== undefined);
    return value;
  });
}

const PERMUTATIONS: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4],
  [4, 3, 2, 1, 0],
  [2, 0, 4, 1, 3],
  [1, 3, 0, 4, 2],
];

function byVerdict(results: RowReconciliation[]): Map<number, RowReconciliation> {
  return new Map(results.map((r) => [r.rowIndex, r]));
}

test("evidence priority: token beats hostname beats ip, lexicographically", () => {
  // Inventory: three endpoints on site S.
  const inventory = [
    inv("E1", "tok-1", "host-a", "10.0.0.1", "S"),
    inv("E2", "tok-2", "host-b", "10.0.0.2", "S"),
    inv("E3", "tok-3", "host-c", "10.0.0.3", "S"),
  ];
  const rows: ImportRow[] = [
    // R0: token evidence for E1 only.
    row("tok-1", "unrelated", "192.168.0.1", "S"),
    // R1: hostname evidence for E2, ip evidence for E1 (two local candidates).
    row(undefined, "host-b", "10.0.0.1", "S"),
    // R2: hostname evidence for E3, ip evidence for E1 (two local candidates).
    row(undefined, "host-c", "10.0.0.1", "S"),
    // R3: token provided but unknown; hostname/ip match E1 yet token differs,
    // so no association is allowed -> definite new.
    row("tok-9", "host-a", "10.0.0.1", "S"),
    // R4: no evidence at all -> definite new.
    row(undefined, "host-z", "172.16.0.9", "S"),
  ];

  // The unique lexicographic optimum is (token=1, hostname=2, ip=0):
  // R0->E1, R1->E2, R2->E3. Giving up the single token association could
  // never be compensated by extra ip-tier associations.
  const expected: readonly RowReconciliation[] = [
    { rowIndex: 0, verdict: "matched", possibleEndpointIds: ["E1"], canBeUnmatched: false },
    { rowIndex: 1, verdict: "matched", possibleEndpointIds: ["E2"], canBeUnmatched: false },
    { rowIndex: 2, verdict: "matched", possibleEndpointIds: ["E3"], canBeUnmatched: false },
    { rowIndex: 3, verdict: "added", possibleEndpointIds: [], canBeUnmatched: true },
    { rowIndex: 4, verdict: "added", possibleEndpointIds: [], canBeUnmatched: true },
  ];

  for (const rowOrder of PERMUTATIONS) {
    for (const invOrder of PERMUTATIONS) {
      const invPerm = invOrder.filter((i) => i < inventory.length);
      const reconciler = createReconciler(permute(inventory, invPerm));
      const shuffledRows = permute(rows, rowOrder);
      const results = byVerdict(reconciler.reconcile(shuffledRows));
      for (let original = 0; original < rows.length; original++) {
        const shuffledIndex = rowOrder.indexOf(original);
        const actual = results.get(shuffledIndex);
        const want = expected[original];
        assert.ok(actual, `missing result for row ${original}`);
        assert.deepEqual(
          {
            verdict: actual.verdict,
            possibleEndpointIds: actual.possibleEndpointIds,
            canBeUnmatched: actual.canBeUnmatched,
          },
          {
            verdict: want?.verdict,
            possibleEndpointIds: want?.possibleEndpointIds,
            canBeUnmatched: want?.canBeUnmatched,
          },
          `row ${original} mismatch (rowOrder=${rowOrder}, invOrder=${invPerm})`,
        );
      }
    }
  }
});

test("three identical tokenless rows compete for two identical endpoints", () => {
  const inventory = [
    inv("E1", "tok-1", "shared-host", "10.1.1.1", "S"),
    inv("E2", "tok-2", "shared-host", "10.1.1.1", "S"),
  ];
  const rows: ImportRow[] = [
    row(undefined, "shared-host", "10.1.1.1", "S"),
    row(undefined, "shared-host", "10.1.1.1", "S"),
    row(undefined, "shared-host", "10.1.1.1", "S"),
  ];

  const results = createReconciler(inventory).reconcile(rows);
  assert.equal(results.length, 3);
  for (const result of results) {
    // Every row may be associated with either endpoint in some optimum...
    assert.deepEqual(result.possibleEndpointIds, ["E1", "E2"]);
    // ...and every row may be the one left unmatched in some optimum.
    assert.equal(result.canBeUnmatched, true);
    // Therefore no row may be reported as definitely new.
    assert.equal(result.verdict, "ambiguous");
  }
});

test("reconciler is reusable across batches and does not mutate inputs", () => {
  const inventory = [inv("E1", "tok-1", "host-a", "10.0.0.1", "S")];
  const reconciler = createReconciler(inventory);

  const first = reconciler.reconcile([row("tok-1", "host-a", "10.0.0.1", "S")]);
  assert.deepEqual(first[0]?.possibleEndpointIds, ["E1"]);
  assert.equal(first[0]?.verdict, "matched");

  const second = reconciler.reconcile([row(undefined, "host-b", "10.9.9.9", "S")]);
  assert.equal(second[0]?.verdict, "added");

  assert.deepEqual(
    inventory,
    [inv("E1", "tok-1", "host-a", "10.0.0.1", "S")],
    "inventory snapshot must not be mutated",
  );
});
