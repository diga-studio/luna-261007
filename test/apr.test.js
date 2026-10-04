const { test } = require("node:test");
const assert = require("node:assert/strict");
const { analyze, npv, WIDTH_LIMIT } = require("../dist/src/apr");
const { Rational } = require("../dist/src/rational");

const R = (n, d = 1n) => Rational.of(n, d);

function expectFinite(result) {
  assert.equal(result.kind, "finite");
  return result.candidates;
}

function checkCandidate(cand, expectedRoot, expectedMultiplicity, label) {
  assert.ok(
    cand.lower.compare(expectedRoot) <= 0 && cand.upper.compare(expectedRoot) >= 0,
    `${label}: interval [${cand.lower}, ${cand.upper}] must contain ${expectedRoot}`,
  );
  assert.ok(
    cand.upper.sub(cand.lower).compare(WIDTH_LIMIT) <= 0,
    `${label}: interval width must be <= 1e-10`,
  );
  assert.ok(cand.lower.compare(R(0n)) >= 0, `${label}: lower bound within [0, 6]`);
  assert.ok(cand.upper.compare(R(6n)) <= 0, `${label}: upper bound within [0, 6]`);
  assert.equal(cand.multiplicity, expectedMultiplicity, `${label}: multiplicity`);
}

function checkWellFormed(candidates) {
  for (let i = 1; i < candidates.length; i++) {
    assert.ok(
      candidates[i - 1].upper.compare(candidates[i].lower) < 0,
      "candidate intervals must be ascending and disjoint",
    );
  }
}

test("double root at 1.2 with same-sign NPV on both sides", () => {
  const records = [
    { month: 0, cents: 10000n },
    { month: 1, cents: -22000n },
    { month: 2, cents: 12100n },
  ];
  const candidates = expectFinite(analyze(records));
  assert.equal(candidates.length, 1);
  checkCandidate(candidates[0], R(6n, 5n), 2, "double root");
  // Even multiplicity: NPV keeps its sign across the root.
  assert.ok(npv(records, R(1n)).sign() > 0);
  assert.ok(npv(records, R(7n, 5n)).sign() > 0);
  // Exact NPV at the root is exactly zero.
  assert.ok(npv(records, R(6n, 5n)).isZero());
});

test("two simple roots 1.2 and 1.20000012 isolated separately", () => {
  const records = [
    { month: 0, cents: 1_000_000_000n },
    { month: 1, cents: -2_200_000_010n },
    { month: 2, cents: 1_210_000_011n },
  ];
  const candidates = expectFinite(analyze(records));
  assert.equal(candidates.length, 2);
  checkCandidate(candidates[0], R(6n, 5n), 1, "root 1.2");
  checkCandidate(candidates[1], R(30_000_003n, 25_000_000n), 1, "root 1.20000012");
  checkWellFormed(candidates);
  assert.ok(npv(records, R(6n, 5n)).isZero());
  assert.ok(npv(records, R(30_000_003n, 25_000_000n)).isZero());
});

// P(x) = (x-1)(2x-3)(x-2)(2x-1)(5x-6)^2 (x^2+1)^9, degree 24, integer coefficients.
// Roots: x=1 (a=0, mult 1), x=3/2 (a=6, mult 1), x=6/5 (a=2.4, mult 2),
// out-of-range x=2 (a=12) and x=1/2 (a=-6), plus complex roots from x^2+1.
function buildDegree24Polynomial() {
  const mul = (a, b) => {
    const out = new Array(a.length + b.length - 1).fill(0n);
    for (let i = 0; i < a.length; i++)
      for (let j = 0; j < b.length; j++) out[i + j] += a[i] * b[j];
    return out;
  };
  const binom = (n, k) => {
    let r = 1n;
    for (let i = 0n; i < k; i++) r = (r * (n - i)) / (i + 1n);
    return r;
  };
  let p = [-1n, 1n]; // x-1
  p = mul(p, [-3n, 2n]); // 2x-3
  p = mul(p, [-2n, 1n]); // x-2
  p = mul(p, [-1n, 2n]); // 2x-1
  p = mul(p, [36n, -60n, 25n]); // (5x-6)^2
  const xsq1_9 = new Array(19).fill(0n); // (x^2+1)^9
  for (let k = 0n; k <= 9n; k++) xsq1_9[Number(2n * k)] = binom(9n, k);
  p = mul(p, xsq1_9);
  assert.equal(p.length - 1, 24);
  return p; // ascending coefficients
}

function degree24Records() {
  const p = buildDegree24Polynomial();
  const records = [];
  for (let m = 0; m <= 24; m++) {
    const cents = p[24 - m]; // coefficient of x^(24-m)
    if (cents !== 0n) records.push({ month: m, cents });
  }
  return records;
}

function checkDegree24(records) {
  const candidates = expectFinite(analyze(records));
  assert.equal(candidates.length, 3, "exactly the three in-range roots");
  checkCandidate(candidates[0], R(0n), 1, "endpoint root a=0");
  checkCandidate(candidates[1], R(12n, 5n), 2, "double root a=2.4");
  checkCandidate(candidates[2], R(6n), 1, "endpoint root a=6");
  checkWellFormed(candidates);
  assert.ok(npv(records, R(0n)).isZero());
  assert.ok(npv(records, R(12n, 5n)).isZero());
  assert.ok(npv(records, R(6n)).isZero());
  return candidates;
}

test("degree-24 cashflow: endpoint roots, out-of-range roots, and a double root", () => {
  const records = degree24Records();
  const baseline = checkDegree24(records).map((c) => ({
    lower: c.lower.toString(),
    upper: c.upper.toString(),
    multiplicity: c.multiplicity,
  }));

  // Shuffled order, split months, and self-canceling extra records must not
  // change the candidate set or multiplicities.
  const permutation = [5, 0, 11, 3, 17, 2, 23, 8, 14, 20, 1, 7, 13, 19, 24, 4, 10, 16, 22, 6, 12, 18, 21, 9, 15];
  const variant = [];
  for (const idx of permutation) {
    const rec = records.find((r) => r.month === idx);
    if (!rec) continue;
    const half = rec.cents / 2n;
    variant.push({ month: rec.month, cents: half });
    variant.push({ month: rec.month, cents: rec.cents - half });
  }
  variant.push({ month: 7, cents: 123_456_789n });
  variant.push({ month: 7, cents: -123_456_789n });
  const rerun = checkDegree24(variant).map((c) => ({
    lower: c.lower.toString(),
    upper: c.upper.toString(),
    multiplicity: c.multiplicity,
  }));
  assert.deepEqual(rerun, baseline);
});

test("no candidate when all roots lie outside [0, 6]", () => {
  // P(x) = 100 x^24 - 50 x^23 = x^23 (100x - 50): roots x=0 and x=1/2 (a=-6).
  const result = analyze([
    { month: 0, cents: 100n },
    { month: 1, cents: -50n },
  ]);
  assert.equal(result.kind, "none");
});

test("indeterminate when cashflows vanish identically", () => {
  assert.equal(analyze([]).kind, "indeterminate");
  assert.equal(
    analyze([
      { month: 3, cents: 500n },
      { month: 3, cents: -500n },
      { month: 9, cents: 0n },
    ]).kind,
    "indeterminate",
  );
});

test("npv is exact rational arithmetic", () => {
  const records = [
    { month: 0, cents: 1200n },
    { month: 1, cents: -1210n },
  ];
  // Root at 1 + a/12 = 1210/1200, i.e. a = 1/10.
  assert.ok(npv(records, R(1n, 10n)).isZero());
  // V(0) is exactly the sum of cents.
  assert.ok(npv(records, R(0n)).equals(R(-10n)));
  // V(6/5) = 1200 - 1210 / (1 + 1/10) = 1200 - 1100 = 100... check via exact value:
  // 1 + (6/5)/12 = 11/10, so V = 1200 - 1210*10/11 = 1200 - 1100 = 100.
  assert.ok(npv(records, R(6n, 5n)).equals(R(100n)));
});

test("input validation rejects bad records", () => {
  assert.throws(() => analyze([{ month: 25, cents: 1n }]));
  assert.throws(() => analyze([{ month: -1, cents: 1n }]));
  assert.throws(() => analyze([{ month: 1.5, cents: 1n }]));
  assert.throws(() => analyze([{ month: 1, cents: 1.5 }]));
});
