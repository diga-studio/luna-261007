import { test } from "node:test";
import assert from "node:assert/strict";
import lib from "../dist/index.js";
import { makeRng, randomPool, randomReps } from "./helpers.mjs";

const { DiversitySession } = lib;

const N = 20000;
const M = 2000;
const K = 200;
const TIME_LIMIT_MS = 60_000;
const MEM_LIMIT_BYTES = 64 * 1024 * 1024;

function memUsed() {
  global.gc();
  const { heapUsed, external } = process.memoryUsage();
  return heapUsed + external;
}

test("full scale: 20000 samples, 2000 reps, batch of 200", { timeout: 300_000 }, () => {
  const rng = makeRng(20261007);
  const samples = randomPool(rng, N);
  const reps = randomReps(rng, M);
  // pre-label 1000 samples spread over the pool
  const labeled = new Set();
  for (let i = 0; i < 1000; i++) labeled.add(samples[Math.floor(rng() * N)].id);

  const memBefore = memUsed();
  const t0 = performance.now();

  const session = new DiversitySession({ samples, representatives: reps, labeledIds: labeled });
  const batch = session.recommend(K);

  const elapsedMs = performance.now() - t0;
  const memAfter = memUsed();
  const extraMem = memAfter - memBefore;

  console.log(`  first batch: ${elapsedMs.toFixed(0)} ms, extra memory: ${(extraMem / 1024 / 1024).toFixed(1)} MiB`);

  assert.ok(elapsedMs <= TIME_LIMIT_MS, `first batch took ${elapsedMs.toFixed(0)} ms > ${TIME_LIMIT_MS} ms`);
  assert.ok(extraMem <= MEM_LIMIT_BYTES, `extra memory ${(extraMem / 1024 / 1024).toFixed(1)} MiB > 64 MiB`);

  // returned count
  assert.equal(batch.length, K);
  // uniqueness
  assert.equal(new Set(batch).size, K);
  // labeled excluded
  for (const id of batch) assert.ok(!labeled.has(id), `labeled id ${id} recommended`);
  for (const id of batch) assert.ok(samples.some((s) => s.id === id), `unknown id ${id}`);

  // determinism: same state, same request -> identical ordered result
  const again = session.recommend(K);
  assert.deepEqual(again, batch);
  // prefix property
  const shorter = session.recommend(50);
  assert.deepEqual(batch.slice(0, 50), shorter);

  // labeling the full batch removes exactly those ids from the next batch
  session.markLabeled(batch);
  const next = session.recommend(K);
  assert.equal(next.length, K);
  for (const id of next) assert.ok(!batch.includes(id), `already labeled id ${id} recommended`);
});
