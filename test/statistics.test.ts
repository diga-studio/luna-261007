import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWalk, M } from '../dist/index.js';

/**
 * Distributional validation over N = 4096 fixed seeds.
 *
 * Every quantity below is normalized to have distribution N(0,1) under a
 * correct random walk. Across N i.i.d. seeds:
 *   - the sample mean of a N(0,1) series is N(0, 1/N); a 5-sigma band is
 *     5/sqrt(N) = 0.0781 (false-alarm prob ~6e-7 per check);
 *   - the sample variance has std sqrt(2/(N-1)) = 0.0221; we use a 6-sigma
 *     band of 0.133 (false-alarm prob ~2e-9);
 *   - the mean of a product of two independent N(0,1) series has std
 *     1/sqrt(N); we reuse the 5-sigma band 0.0781;
 *   - a tail frequency with true probability p has std sqrt(p(1-p)/N);
 *     we use a 5-sigma band around p.
 */

const N = 4096;
const SIGMA = 1.3;
const INITIAL = 500;
const MEAN_TOL = 5 / Math.sqrt(N); // 0.0781
const VAR_TOL = 6 * Math.sqrt(2 / (N - 1)); // 0.1327

const LONG_START = 1_500_000;
const LONG_H = 1_000_000;
const U_START = 2_000_000;
const U_H = 1_000_000;
const V_START = 7_000_000;
const V_H = 1_000_000;
const FAR = M - 501; // unit increment far from index 0

// Per-seed normalized samples.
const x1 = new Float64Array(N); // unit increment near 0
const x1next = new Float64Array(N); // the adjacent (disjoint) unit increment
const xLong = new Float64Array(N); // length-1e6 increment
const xFar = new Float64Array(N); // unit increment near M
const u = new Float64Array(N); // increment over interval U
const v = new Float64Array(N); // increment over disjoint interval V
const xCross = new Float64Array(N); // same increment, different streamId

for (let i = 0; i < N; i++) {
  const w = createWalk(BigInt(i), 'stats/A', INITIAL, SIGMA);
  const at = (n: number) => w.valueAt(n);
  x1[i] = (at(11) - at(10)) / SIGMA;
  x1next[i] = (at(12) - at(11)) / SIGMA;
  xLong[i] = (at(LONG_START + LONG_H) - at(LONG_START)) / (SIGMA * Math.sqrt(LONG_H));
  xFar[i] = (at(FAR + 1) - at(FAR)) / SIGMA;
  u[i] = (at(U_START + U_H) - at(U_START)) / (SIGMA * Math.sqrt(U_H));
  v[i] = (at(V_START + V_H) - at(V_START)) / (SIGMA * Math.sqrt(V_H));
  const wb = createWalk(BigInt(i), 'stats/B', INITIAL, SIGMA);
  xCross[i] = (wb.valueAt(11) - wb.valueAt(10)) / SIGMA;
}

function mean(a: Float64Array): number {
  let s = 0;
  for (const x of a) s += x;
  return s / a.length;
}

function variance(a: Float64Array): number {
  const m = mean(a);
  let s = 0;
  for (const x of a) s += (x - m) * (x - m);
  return s / (a.length - 1);
}

function crossMean(a: Float64Array, b: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s / a.length;
}

function checkSeries(name: string, a: Float64Array): void {
  const m = mean(a);
  const va = variance(a);
  assert.ok(Math.abs(m) < MEAN_TOL, `${name}: mean ${m} outside 5-sigma band ${MEAN_TOL}`);
  assert.ok(
    Math.abs(va - 1) < VAR_TOL,
    `${name}: variance ${va} outside 6-sigma band around 1 (tol ${VAR_TOL})`,
  );
}

test('unit increments near index 0 are N(0, sigma^2)', () => {
  checkSeries('unit increment', x1);
});

test('long-span (h=1e6) increments have variance h*sigma^2', () => {
  checkSeries('long-span increment', xLong);
});

test('unit increments far from zero (near M) are N(0, sigma^2)', () => {
  checkSeries('far-from-zero increment', xFar);
});

test('disjoint increments are uncorrelated', () => {
  // Adjacent unit increments.
  const c1 = crossMean(x1, x1next);
  assert.ok(Math.abs(c1) < MEAN_TOL, `adjacent-increment covariance ${c1}`);
  // Increments over disjoint length-1e6 intervals.
  const c2 = crossMean(u, v);
  assert.ok(Math.abs(c2) < MEAN_TOL, `disjoint-interval covariance ${c2}`);
  // Short vs long disjoint intervals.
  const c3 = crossMean(x1, u);
  assert.ok(Math.abs(c3) < MEAN_TOL, `short-vs-long covariance ${c3}`);
});

test('increments are independent across streamIds', () => {
  const c = crossMean(x1, xCross);
  assert.ok(Math.abs(c) < MEAN_TOL, `cross-stream correlation ${c}`);
  checkSeries('cross-stream increment', xCross);
});

test('tails match the Gaussian shape', () => {
  // P(|N(0,1)| > 2) = 0.045500...
  const p = 0.04550026389635842;
  let count = 0;
  for (const x of x1) if (Math.abs(x) > 2) count++;
  const freq = count / N;
  const tol = 5 * Math.sqrt((p * (1 - p)) / N); // 5-sigma band
  assert.ok(Math.abs(freq - p) < tol, `tail freq ${freq} vs ${p} (tol ${tol})`);
});

test('variance grows linearly with span (multiple scales)', () => {
  // For spans h = 1, 1e3, 1e6 the normalized increments must all be N(0,1);
  // a process matching only marginal pointwise variance would fail here.
  checkSeries('span 1', x1);
  const spans: Array<[string, Float64Array]> = [
    ['span 1e6', xLong],
  ];
  for (const [name, a] of spans) checkSeries(name, a);
});
