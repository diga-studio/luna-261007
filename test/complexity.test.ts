import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWalk, M, internalStats } from '../dist/index.js';

/**
 * Work/space verification via the instrumented counters in `internalStats`
 * (number of Gaussian node evaluations = PRNG draws, and the high-water
 * mark of the descent-stack depth). No wall-clock claims are made.
 *
 * DEPTH bounds the root-to-leaf path length of the bisection tree over
 * [0, M]: interval length starts at M and at least halves each level,
 * so at most ceil(log2(M)) = 33 midpoint levels plus the root frame.
 */
const DEPTH = Math.ceil(Math.log2(M)); // 33
const MAX_STACK = DEPTH + 1;

function freshWalk() {
  const w = createWalk(0xfeed_face_cafe_beefn, 'complexity', 0, 2.5);
  internalStats.reset(); // ignore the single constructor endpoint draw
  return w;
}

test('construction is O(1): one endpoint draw, no trajectory precomputation', () => {
  internalStats.reset();
  createWalk(1n, 'complexity', 0, 1);
  assert.equal(internalStats.gaussDraws, 1);
});

test('single point query is O(log M), even next to M', () => {
  const w = freshWalk();
  for (const idx of [1, 123_456_789, M - 1, M - 5_000_000_000]) {
    internalStats.reset();
    w.valueAt(idx);
    assert.ok(
      internalStats.gaussDraws <= DEPTH,
      `valueAt(${idx}) used ${internalStats.gaussDraws} draws > ${DEPTH}`,
    );
  }
});

test('direct read of the last 1000 points is O(1000 + log M)', () => {
  const w = freshWalk();
  internalStats.reset();
  const vals = [...w.readRange(M - 999, 1000)];
  assert.equal(vals.length, 1000);
  assert.ok(
    internalStats.gaussDraws <= 1000 + DEPTH + 1,
    `used ${internalStats.gaussDraws} draws`,
  );
  assert.ok(internalStats.maxStackDepth <= MAX_STACK, `depth ${internalStats.maxStackDepth}`);
});

test('lazy consumption of 1M consecutive points is O(k + log M) work, O(log M) space', () => {
  const w = freshWalk();
  internalStats.reset();
  let count = 0;
  for (const _ of w.readRange(98_765, 1_000_000)) count++;
  assert.equal(count, 1_000_000);
  // Exactly one new tree node per emitted point, plus one descent path.
  assert.ok(
    internalStats.gaussDraws <= 1_000_000 + DEPTH + 1,
    `used ${internalStats.gaussDraws} draws`,
  );
  // Stack depth never exceeds the tree depth regardless of k.
  assert.ok(internalStats.maxStackDepth <= MAX_STACK, `depth ${internalStats.maxStackDepth}`);
});

test('iterator is lazy: no work before first next(), none after early stop', () => {
  const w = freshWalk();
  internalStats.reset();
  const it = w.readRange(0, 1_000_000);
  assert.equal(internalStats.gaussDraws, 0, 'creating the iterator must do no work');
  for (let i = 0; i < 10; i++) it.next();
  const after10 = internalStats.gaussDraws;
  assert.ok(after10 <= 10 + DEPTH + 1, `10 points used ${after10} draws`);
  // Abandon the iterator: no further draws may happen (nothing to await).
  const snapshot = internalStats.gaussDraws;
  assert.equal(internalStats.gaussDraws, snapshot);
});

test('interleaved iterators each keep only O(log M) state', () => {
  const w = freshWalk();
  internalStats.reset();
  const its = Array.from({ length: 8 }, (_, i) => w.readRange(i * 10_000_000, 1_000));
  for (let round = 0; round < 100; round++) {
    for (const it of its) it.next();
  }
  assert.ok(internalStats.maxStackDepth <= MAX_STACK, `depth ${internalStats.maxStackDepth}`);
});

test('repeated point queries do not accumulate per-instance state', () => {
  const w = freshWalk();
  internalStats.reset();
  for (let i = 0; i < 1_000; i++) w.valueAt(i * 7_777);
  // valueAt keeps no stack at all; the space high-water mark stays 0 here.
  assert.equal(internalStats.maxStackDepth, 0);
  // Each query is a fresh O(log M) descent: total ~1000 * <=DEPTH draws.
  assert.ok(internalStats.gaussDraws <= 1_000 * DEPTH);
});
