import { test } from "node:test";
import assert from "node:assert/strict";
import { createWalk, M, Walk } from "../src/walk";

const SEED = 0x123456789abcdefn;
const STREAM = "device-alpha";
const INITIAL = 3.25;
const SIGMA = 1.7;

function fresh(): Walk {
  return createWalk(SEED, STREAM, INITIAL, SIGMA);
}

/** Deterministic LCG for shuffles and fragment sizes. */
function lcg(state: { s: number }): number {
  state.s = (state.s * 1103515245 + 12345) & 0x7fffffff;
  return state.s;
}

test("X(0) equals initial exactly", () => {
  const w = fresh();
  assert.equal(w.valueAt(0), INITIAL);
  assert.equal(w.valueAt(M) === w.valueAt(M), true);
});

test("shuffled overlapping fragments from fresh instances match full read bitwise", () => {
  const start = 1_234_567;
  const len = 4096;
  const full = [...fresh().readRange(start, len)];

  // Variable-size fragments covering [start, start+len), plus overlapping extras.
  const st = { s: 42 };
  const frags: Array<[number, number]> = [];
  let pos = 0;
  const sizes = [1, 7, 64, 333, 1000, 2, 511, 128];
  let k = 0;
  while (pos < len) {
    const size = Math.min(sizes[k++ % sizes.length], len - pos);
    frags.push([start + pos, size]);
    pos += size;
  }
  frags.push([start + 100, 2000]); // overlapping fragment
  frags.push([start + len - 500, 500]);
  // Shuffle read order.
  for (let i = frags.length - 1; i > 0; i--) {
    const j = lcg(st) % (i + 1);
    [frags[i], frags[j]] = [frags[j], frags[i]];
  }
  for (const [s, c] of frags) {
    const got = [...fresh().readRange(s, c)]; // brand-new instance per fragment
    for (let i = 0; i < c; i++) {
      assert.equal(got[i], full[s - start + i], `mismatch at index ${s + i}`);
    }
  }
});

test("valueAt matches readRange pointwise, including near M", () => {
  const w = fresh();
  const spots = [0, 1, 2, 999_999, 4_000_000_000, M - 2, M - 1, M];
  const ref = [...w.readRange(M - 3, 4)];
  assert.deepEqual(
    [w.valueAt(M - 3), w.valueAt(M - 2), w.valueAt(M - 1), w.valueAt(M)],
    ref,
  );
  for (const i of spots) {
    const viaRange = [...fresh().readRange(i, 1)][0];
    assert.equal(w.valueAt(i), viaRange, `index ${i}`);
  }
});

test("interleaved iterators stay consistent with each other and valueAt", () => {
  const w = fresh();
  const a = w.readRange(5000, 300)[Symbol.iterator]();
  const b = w.readRange(5050, 300)[Symbol.iterator]();
  for (let i = 0; i < 300; i++) {
    const va = a.next();
    const vb = b.next();
    assert.equal(va.done, false);
    assert.equal(vb.done, false);
    assert.equal(va.value, w.valueAt(5000 + i));
    assert.equal(vb.value, w.valueAt(5050 + i));
  }
});

test("early stop then re-read gives identical values", () => {
  const w = fresh();
  const it = w.readRange(77_000, 10_000)[Symbol.iterator]();
  const head: number[] = [];
  for (let i = 0; i < 10; i++) head.push(it.next().value);
  // Abandon the iterator; re-read the same prefix with a fresh iterator.
  const again = [...w.readRange(77_000, 10)];
  assert.deepEqual(head, again);
  // And a fresh instance agrees too.
  assert.deepEqual([...fresh().readRange(77_000, 10)], head);
});

test("rebuilt instances are bit-identical; other streams/seeds differ", () => {
  const idx = [0, 1, 123_456_789, M - 1, M];
  const a = fresh();
  const b = fresh();
  for (const i of idx) assert.equal(a.valueAt(i), b.valueAt(i));
  const c = createWalk(SEED, "device-beta", INITIAL, SIGMA);
  const d = createWalk(SEED ^ 0xffn, STREAM, INITIAL, SIGMA);
  assert.notEqual(a.valueAt(123_456_789), c.valueAt(123_456_789));
  assert.notEqual(a.valueAt(123_456_789), d.valueAt(123_456_789));
});
