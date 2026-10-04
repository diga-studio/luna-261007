import { test } from "node:test";
import assert from "node:assert/strict";
import { createWalk, M } from "../src/walk";

/**
 * Statistical validation across 4096 fixed seeds.
 * All thresholds are 5-sigma under the null (normal/chi-square approximations),
 * so a correct implementation fails with probability well below 1e-5 per test.
 */

const N = 4096;
const SIGMA = 1.3;
const SEEDS: bigint[] = [];
for (let i = 0; i < N; i++) {
  SEEDS.push((BigInt(i) * 0x9e3779b97f4a7c15n + 0x2545f4914f6cdd1dn) & ((1n << 64n) - 1n));
}

// Fixed probe points: short span, long span, and far from zero.
const A = 12_345;            // short-span anchor
const H_SHORT = 1;           // single step
const H_MID = 1000;          // medium span
const B = 50_000_000;        // long-span anchor
const H_LONG = 100_000_000;  // long span
const C = M - 5_000_000;     // far-from-zero anchor
const H_FAR = 1_000_000;

interface Moments { mean: number; variance: number }
function moments(xs: number[]): Moments {
  let s = 0;
  for (const x of xs) s += x;
  const mean = s / xs.length;
  let v = 0;
  for (const x of xs) v += (x - mean) * (x - mean);
  return { mean, variance: v / (xs.length - 1) };
}
function correlation(xs: number[], ys: number[]): number {
  const mx = moments(xs), my = moments(ys);
  let c = 0;
  for (let i = 0; i < xs.length; i++) c += (xs[i] - mx.mean) * (ys[i] - my.mean);
  return c / ((xs.length - 1) * Math.sqrt(mx.variance * my.variance));
}

// Collect increments per seed in one pass.
const dShort: number[] = [];   // X(A+1)-X(A)
const dMid1: number[] = [];    // X(A+H_MID)-X(A)
const dMid2: number[] = [];    // X(A+2*H_MID)-X(A+H_MID), disjoint from dMid1
const dLong: number[] = [];    // X(B+H_LONG)-X(B)
const dFar: number[] = [];     // X(C+H_FAR)-X(C)
const dOther: number[] = [];   // same seeds, different streamId, X(A+H_MID)-X(A)

let collected = false;
function collect(): void {
  if (collected) return;
  collected = true;
  for (const seed of SEEDS) {
    const w = createWalk(seed, "stats-main", 0, SIGMA);
    const xA = w.valueAt(A);
    const xA1 = w.valueAt(A + H_SHORT);
    const xAm = w.valueAt(A + H_MID);
    const xA2m = w.valueAt(A + 2 * H_MID);
    dShort.push(xA1 - xA);
    dMid1.push(xAm - xA);
    dMid2.push(xA2m - xAm);
    dLong.push(w.valueAt(B + H_LONG) - w.valueAt(B));
    dFar.push(w.valueAt(C + H_FAR) - w.valueAt(C));
    const w2 = createWalk(seed, "stats-other", 0, SIGMA);
    dOther.push(w2.valueAt(A + H_MID) - w2.valueAt(A));
  }
}

const Z_MAX = 5;

function checkMean(xs: number[], spanVar: number, label: string): void {
  const m = moments(xs);
  const se = Math.sqrt(spanVar / xs.length);
  const z = m.mean / se;
  assert.ok(Math.abs(z) < Z_MAX, `${label}: mean z=${z.toFixed(3)} (|z| must be < ${Z_MAX})`);
}
function checkVariance(xs: number[], spanVar: number, label: string): void {
  const m = moments(xs);
  // Sample variance of n Gaussians: Var ~= 2*trueVar^2/(n-1).
  const se = Math.sqrt(2 / (xs.length - 1)) * spanVar;
  const z = (m.variance - spanVar) / se;
  assert.ok(Math.abs(z) < Z_MAX, `${label}: var z=${z.toFixed(3)} (got ${m.variance}, want ${spanVar})`);
}

test("increment means are zero (short, long, far-from-zero spans)", () => {
  collect();
  const s2 = SIGMA * SIGMA;
  checkMean(dShort, s2 * H_SHORT, "short span");
  checkMean(dMid1, s2 * H_MID, "mid span");
  checkMean(dLong, s2 * H_LONG, "long span");
  checkMean(dFar, s2 * H_FAR, "far-from-zero span");
});

test("increment variances equal h*sigma^2 (short, long, far-from-zero spans)", () => {
  collect();
  const s2 = SIGMA * SIGMA;
  checkVariance(dShort, s2 * H_SHORT, "short span");
  checkVariance(dMid1, s2 * H_MID, "mid span");
  checkVariance(dLong, s2 * H_LONG, "long span");
  checkVariance(dFar, s2 * H_FAR, "far-from-zero span");
});

test("disjoint increments are uncorrelated", () => {
  collect();
  const r = correlation(dMid1, dMid2);
  const bound = Z_MAX / Math.sqrt(N);
  assert.ok(Math.abs(r) < bound, `corr(disjoint)=${r.toFixed(4)}, bound ${bound.toFixed(4)}`);
});

test("overlapping increments have exactly the shared-variance correlation", () => {
  collect();
  // corr(X(A+2h)-X(A), X(A+h)-X(A)) = h*s^2 / sqrt(2h*s^2 * h*s^2) = 1/sqrt(2).
  const total: number[] = [];
  for (let i = 0; i < N; i++) total.push(dMid1[i] + dMid2[i]);
  const r = correlation(total, dMid1);
  // Fisher z-transform: SE = 1/sqrt(N-3).
  const z = (Math.atanh(r) - Math.atanh(1 / Math.sqrt(2))) * Math.sqrt(N - 3);
  assert.ok(Math.abs(z) < Z_MAX, `overlap corr=${r.toFixed(4)} (want 0.7071), fisher z=${z.toFixed(3)}`);
});

test("increments are uncorrelated across streamIds (cross-device)", () => {
  collect();
  const r = correlation(dMid1, dOther);
  const bound = Z_MAX / Math.sqrt(N);
  assert.ok(Math.abs(r) < bound, `corr(cross-stream)=${r.toFixed(4)}, bound ${bound.toFixed(4)}`);
});

test("unit increments are Gaussian: skewness and excess kurtosis near 0", () => {
  collect();
  // Shape check on the joint generator, not just the marginal variance.
  const m = moments(dShort);
  let m3 = 0, m4 = 0;
  for (const x of dShort) {
    const d = (x - m.mean) / Math.sqrt(m.variance);
    m3 += d * d * d;
    m4 += d * d * d * d;
  }
  const skew = m3 / N;
  const kurt = m4 / N - 3;
  // Under normality: SE(skew)=sqrt(6/N), SE(excess kurtosis)=sqrt(24/N).
  assert.ok(Math.abs(skew) < Z_MAX * Math.sqrt(6 / N), `skew=${skew.toFixed(4)}`);
  assert.ok(Math.abs(kurt) < Z_MAX * Math.sqrt(24 / N), `excess kurtosis=${kurt.toFixed(4)}`);
});
