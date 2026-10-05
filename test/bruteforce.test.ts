import { test } from "node:test";
import assert from "node:assert/strict";
import { createReconciler } from "../src/reconciler";
import { ImportRow, InventoryRecord, RowConclusion } from "../src/types";

type Objective = [number, number, number];

function edgeLevel(
  row: ImportRow,
  record: InventoryRecord
): 0 | 1 | 2 | null {
  if (row.agentToken !== undefined) {
    return row.agentToken === record.agentToken ? 2 : null;
  }
  if (row.hostname === record.hostname && row.site === record.site) return 1;
  if (row.ip === record.ip && row.site === record.site) return 0;
  return null;
}

function bruteForce(
  inventory: InventoryRecord[],
  rows: ImportRow[]
): RowConclusion[] {
  const levels = rows.map((row) => inventory.map((rec) => edgeLevel(row, rec)));
  const assignments: (number | null)[][] = [];
  const current: (number | null)[] = new Array(rows.length).fill(null);
  const used = new Array(inventory.length).fill(false);
  const walk = (r: number) => {
    if (r === rows.length) {
      assignments.push(current.slice());
      return;
    }
    current[r] = null;
    walk(r + 1);
    for (let e = 0; e < inventory.length; e++) {
      if (used[e] || (levels[r] as unknown[])[e] === null) continue;
      used[e] = true;
      current[r] = e;
      walk(r + 1);
      current[r] = null;
      used[e] = false;
    }
  };
  walk(0);

  const score = (a: (number | null)[]): Objective => {
    const obj: Objective = [0, 0, 0];
    a.forEach((e, r) => {
      if (e === null) return;
      const level = (levels[r] as (number | null)[])[e];
      if (level === null || level === undefined) return;
      obj[2 - level] = (obj[2 - level] as number) + 1;
    });
    return obj;
  };
  let best: Objective = [-1, -1, -1];
  for (const a of assignments) {
    const s = score(a);
    if (
      s[0] > best[0] ||
      (s[0] === best[0] && s[1] > best[1]) ||
      (s[0] === best[0] && s[1] === best[1] && s[2] > best[2])
    ) {
      best = s;
    }
  }
  const optimal = assignments.filter((a) => {
    const s = score(a);
    return s[0] === best[0] && s[1] === best[1] && s[2] === best[2];
  });

  return rows.map((_, r) => {
    const possible = new Set<string>();
    let canBeUnmatched = false;
    for (const a of optimal) {
      const e = a[r];
      if (e === null || e === undefined) canBeUnmatched = true;
      else possible.add((inventory[e] as InventoryRecord).endpointId);
    }
    const possibleEndpointIds = [...possible].sort();
    let kind: RowConclusion["kind"];
    if (possibleEndpointIds.length === 1 && !canBeUnmatched) kind = "matched";
    else if (possibleEndpointIds.length === 0 && canBeUnmatched) kind = "new";
    else kind = "ambiguous";
    return { kind, possibleEndpointIds, canBeUnmatched };
  });
}

function makeRng(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

test("matches brute-force enumeration over all optimal assignments", () => {
  for (let seed = 1; seed <= 60; seed++) {
    const rand = makeRng(seed);
    const pick = (options: string[]) =>
      options[Math.floor(rand() * options.length)] as string;
    const endpointCount = 1 + Math.floor(rand() * 4);
    const rowCount = 1 + Math.floor(rand() * 4);
    const hosts = ["h1", "h2", "h3"];
    const ips = ["10.0.0.1", "10.0.0.2", "10.0.0.3"];
    const sites = ["s1", "s2"];
    const inventory: InventoryRecord[] = [];
    for (let i = 0; i < endpointCount; i++) {
      inventory.push({
        endpointId: `E${i}`,
        agentToken: `T${i}`,
        hostname: pick(hosts),
        ip: pick(ips),
        site: pick(sites),
      });
    }
    const rows: ImportRow[] = [];
    for (let i = 0; i < rowCount; i++) {
      const row: ImportRow = {
        hostname: pick(hosts),
        ip: pick(ips),
        site: pick(sites),
      };
      if (rand() < 0.5) {
        const tokens = inventory.map((r) => r.agentToken).concat(["T-new"]);
        row.agentToken = pick(tokens);
      }
      rows.push(row);
    }
    const actual = createReconciler(inventory).reconcile(rows);
    const expected = bruteForce(inventory, rows);
    assert.deepEqual(actual, expected, `seed=${seed}`);
  }
});
