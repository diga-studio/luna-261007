import assert from "node:assert/strict";
import { test } from "node:test";
import { cluster } from "../src/cluster.js";
import type { DedupRecord } from "../src/types.js";
import { mulberry32, randomInt, randomString, shuffle } from "./helpers.js";

test("100k records: exact recall with bounded distance checks", () => {
  const rng = mulberry32(20261006);
  const LEN = 24;

  // 60k distinct pseudo-random originals.
  const used = new Set<string>();
  const originals: string[] = [];
  while (originals.length < 60000) {
    const value = randomString(rng, LEN);
    if (used.has(value)) continue;
    used.add(value);
    originals.push(value);
  }

  const records: DedupRecord[] = [];
  const pushRecord = (id: string, value: string) => {
    records.push({ id, value });
  };
  originals.forEach((value, i) => pushRecord(`orig${i}`, value));

  // 20k single-substitution variants, each from a different source.
  const sourceOrder = shuffle(rng, originals.map((_, i) => i));
  const variantOf = new Map<string, string>(); // variant id -> source id
  for (let i = 0; i < 20000; i++) {
    const sourceIdx = sourceOrder[i];
    const source = originals[sourceIdx];
    let variant = source;
    while (used.has(variant)) {
      const pos = randomInt(rng, 0, LEN - 1);
      let code = randomInt(rng, 0, 25);
      if (String.fromCharCode(97 + code) === source[pos]) {
        code = (code + 1) % 26;
      }
      variant = source.slice(0, pos) + String.fromCharCode(97 + code) + source.slice(pos + 1);
    }
    used.add(variant);
    const id = `var${i}`;
    variantOf.set(id, `orig${sourceIdx}`);
    pushRecord(id, variant);
  }

  // 20k records sharing one identical value.
  const dupValue = "a".repeat(LEN);
  const dupIds: string[] = [];
  for (let i = 0; i < 20000; i++) {
    const id = `dup${i}`;
    dupIds.push(id);
    pushRecord(id, dupValue);
  }

  shuffle(rng, records);
  assert.equal(records.length, 100000);

  const result = cluster(records);
  assert.ok(
    result.stats.distanceChecks <= 2_000_000,
    `distanceChecks ${result.stats.distanceChecks} exceeds 2,000,000`,
  );

  // Map every id to its cluster.
  const clusterOf = new Map<string, number>();
  result.clusters.forEach((c, idx) => {
    for (const id of c.ids) clusterOf.set(String(id), idx);
  });

  // The identical-value cluster contains exactly the 20k dup ids.
  const dupClusterIdx = clusterOf.get("dup0");
  assert.notEqual(dupClusterIdx, undefined);
  const dupCluster = result.clusters[dupClusterIdx!];
  assert.equal(dupCluster.ids.length, 20000);
  for (const id of dupIds) {
    assert.equal(clusterOf.get(id), dupClusterIdx, `${id} missing from dup cluster`);
  }

  // Every variant shares a cluster with its source.
  for (const [variantId, sourceId] of variantOf) {
    const vc = clusterOf.get(variantId);
    const sc = clusterOf.get(sourceId);
    assert.notEqual(vc, undefined, `${variantId} not clustered`);
    assert.equal(vc, sc, `${variantId} separated from source ${sourceId}`);
  }
});
