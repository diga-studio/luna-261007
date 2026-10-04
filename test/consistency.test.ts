import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWalk, M } from '../dist/index.js';
import type { Walk } from '../dist/index.js';

const SEED = 0x1234_5678_9abc_def0n;
const STREAM = 'device/alpha';
const INITIAL = -37.25;
const SIGMA = 1.75;

function fresh(): Walk {
  return createWalk(SEED, STREAM, INITIAL, SIGMA);
}

function take(iter: IterableIterator<number>, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = iter.next();
    assert.equal(r.done, false);
    out.push(r.value);
  }
  return out;
}

// Reference: one full in-order read of [BASE, BASE+LEN) on a fresh instance.
const BASE = 10_000;
const LEN = 4_096;
const reference = [...fresh().readRange(BASE, LEN)];

test('readRange matches valueAt pointwise', () => {
  const w = fresh();
  for (let i = 0; i < LEN; i++) {
    assert.equal(w.valueAt(BASE + i), reference[i], `index ${BASE + i}`);
  }
});

test('out-of-order overlapping chunks from fresh instances match full read', () => {
  // Uneven, overlapping slices covering [BASE, BASE+LEN), consumed out of order.
  const slices: Array<[number, number]> = [
    [BASE + 3_000, 1_096], // reaches BASE+4096
    [BASE + 500, 1_700], // overlaps both neighbours
    [BASE, 1_000],
    [BASE + 2_000, 1_500],
    [BASE + 900, 300],
  ];
  const assembled = new Array<number>(LEN);
  for (const [start, count] of slices) {
    const vals = [...fresh().readRange(start, count)];
    assert.equal(vals.length, count);
    for (let i = 0; i < count; i++) {
      const off = start - BASE + i;
      if (off < 0 || off >= LEN) continue;
      if (assembled[off] !== undefined) {
        assert.equal(vals[i], assembled[off], `overlap mismatch at ${start + i}`);
      }
      assembled[off] = vals[i];
    }
  }
  for (let i = 0; i < LEN; i++) {
    assert.equal(assembled[i], reference[i], `index ${BASE + i}`);
  }
});

test('interleaved iterators on one instance stay consistent', () => {
  const w = fresh();
  const itA = w.readRange(BASE, LEN);
  const itB = w.readRange(BASE + 1_000, 1_000);
  const itC = w.readRange(BASE, 100);
  for (let i = 0; i < 1_000; i++) {
    const a = itA.next().value as number;
    const b = itB.next().value as number;
    assert.equal(a, reference[i]);
    assert.equal(b, reference[1_000 + i]);
    if (i < 100) assert.equal(itC.next().value as number, reference[i]);
  }
});

test('early stop then re-read gives identical prefix', () => {
  const w = fresh();
  const it = w.readRange(BASE + 777, LEN);
  const prefix = take(it, 13); // stop early; rest must never be generated
  const reread = [...fresh().readRange(BASE + 777, 13)];
  assert.deepEqual(reread, prefix);
  for (let i = 0; i < 13; i++) assert.equal(prefix[i], reference[777 + i]);
});

test('rebuilt instances reproduce identical values', () => {
  for (const idx of [0, 1, 2, M - 1, M, BASE + 123, 3_999_999_999]) {
    assert.equal(fresh().valueAt(idx), fresh().valueAt(idx), `index ${idx}`);
  }
  assert.equal(fresh().valueAt(0), INITIAL);
});

test('range near M: chunked vs point reads', () => {
  const start = M - 1_499; // range ends exactly at M
  const full = [...fresh().readRange(start, 1_500)];
  assert.equal(full.length, 1_500);
  const w = fresh();
  for (let i = 0; i < 1_500; i += 137) {
    assert.equal(w.valueAt(start + i), full[i], `index ${start + i}`);
  }
  // Last point of the last possible range is X(M).
  assert.equal(full[1_499], fresh().valueAt(M));
  // Chunked re-read of the tail, out of order.
  const tail1 = [...fresh().readRange(M - 100, 50)];
  const tail2 = [...fresh().readRange(M - 50, 50)];
  for (let i = 0; i < 50; i++) {
    assert.equal(tail1[i], full[1_399 + i]);
    assert.equal(tail2[i], full[1_449 + i]);
  }
});

test('other streams do not perturb this stream', () => {
  const before = [...fresh().readRange(BASE, 500)];
  // Interleave heavy activity on other streams and other instances.
  const other = createWalk(SEED, 'device/beta', INITIAL, SIGMA);
  const otherVals = [...other.readRange(BASE, 500)];
  const after = [...fresh().readRange(BASE, 500)];
  assert.deepEqual(after, before);
  // Different streamId must (overwhelmingly likely) produce a different walk.
  assert.notDeepEqual(otherVals, before);
});
