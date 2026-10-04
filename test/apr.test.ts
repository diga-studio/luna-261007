import { test } from "node:test";
import { equal, ok, throws } from "node:assert/strict";
import { analyze, npv } from "../src/apr.js";
import type { Rational } from "../src/rational.js";
import { parseRational, isZero, sign, toString } from "../src/rational.js";
import { checkCandidatesWellFormed, contains, serialize } from "./helpers.js";


test("double root at 1.2 (sign does not change across the root)", () => {
  const cashflows = [
    { month: 0, cents: 10000 },
    { month: 1, cents: -22000 },
    { month: 2, cents: 12100 },
  ];
  const result = analyze(cashflows);
  equal(result.kind, "finite");
  if (result.kind !== "finite") return;
  equal(result.candidates.length, 1);
  const c = result.candidates[0];
  equal(c.multiplicity, 2);
  ok(contains(c, "1.2"), `interval must contain 1.2, got [${toString(c.lower)}, ${toString(c.upper)}]`);
  checkCandidatesWellFormed(result.candidates);

  // Exact NPV at the root is exactly zero.
  ok(isZero(npv(cashflows, parseRational("1.2"))));
  // Even multiplicity: NPV keeps its sign on both sides.
  ok(sign(npv(cashflows, parseRational("1.19"))) > 0);
  ok(sign(npv(cashflows, parseRational("1.21"))) > 0);
  // NPV at apr 0 equals the plain sum of cents.
  equal(toString(npv(cashflows, parseRational("0"))), "100");
});

test("two simple roots 1.2 and 1.20000012 isolated separately", () => {
  const cashflows = [
    { month: 0, cents: 1000000000 },
    { month: 1, cents: -2200000010 },
    { month: 2, cents: 1210000011 },
  ];
  const result = analyze(cashflows);
  equal(result.kind, "finite");
  if (result.kind !== "finite") return;
  equal(result.candidates.length, 2);
  equal(result.candidates[0].multiplicity, 1);
  equal(result.candidates[1].multiplicity, 1);
  ok(contains(result.candidates[0], "1.2"), "first interval must contain 1.2");
  ok(contains(result.candidates[1], "1.20000012"), "second interval must contain 1.20000012");
  checkCandidatesWellFormed(result.candidates);

  ok(isZero(npv(cashflows, parseRational("1.2"))));
  ok(isZero(npv(cashflows, parseRational("1.20000012"))));
  // Simple roots: sign changes across each root.
  ok(sign(npv(cashflows, parseRational("1.1999999"))) > 0);
  ok(sign(npv(cashflows, parseRational("1.20000006"))) < 0);
  ok(sign(npv(cashflows, parseRational("1.2000002"))) > 0);
});

test("no candidate when the NPV polynomial has no root in [0, 6]", () => {
  // Single inflow, never repaid: V(a) > 0 everywhere.
  equal(analyze([{ month: 0, cents: 5000 }]).kind, "none");
  // Out-of-range root: V(a) = 1 - 2/(1+a/12) has its only root at a = 12.
  equal(
    analyze([
      { month: 0, cents: 1 },
      { month: 1, cents: -2 },
    ]).kind,
    "none",
  );
});

test("indeterminate when all cashflows cancel out", () => {
  equal(analyze([]).kind, "indeterminate");
  equal(
    analyze([
      { month: 3, cents: 700 },
      { month: 3, cents: -700 },
    ]).kind,
    "indeterminate",
  );
});

test("npv is exact rational arithmetic", () => {
  const cashflows = [
    { month: 0, cents: 10000 },
    { month: 1, cents: -22000 },
    { month: 2, cents: 12100 },
  ];
  // V(0.6) = 10000 - 22000/1.05 + 12100/1.05^2
  //        = (10000*1.05^2 - 22000*1.05 + 12100) / 1.05^2
  //        = (11025 - 23100 + 12100) / 1.1025 = 25 / 1.1025 = 10000/441
  const v = npv(cashflows, parseRational("0.6"));
  equal(toString(v), "10000/441");
});

test("input order, splitting and canceling records do not matter", () => {
  const base = [
    { month: 0, cents: 10000 },
    { month: 1, cents: -22000 },
    { month: 2, cents: 12100 },
  ];
  const shuffled = [
    { month: 2, cents: 12100 },
    { month: 0, cents: 10000 },
    { month: 1, cents: -22000 },
  ];
  const splitAndCanceled = [
    { month: 1, cents: -20000 },
    { month: 0, cents: 4000 },
    { month: 2, cents: 12100 },
    { month: 1, cents: -2000 },
    { month: 0, cents: 6000 },
    { month: 5, cents: 12345 },
    { month: 5, cents: -12345 },
  ];
  const expected = serialize(analyze(base));
  equal(serialize(analyze(shuffled)), expected);
  equal(serialize(analyze(splitAndCanceled)), expected);
});

test("rejects invalid records", () => {
  throws(() => analyze([{ month: 25, cents: 1 }]));
  throws(() => analyze([{ month: -1, cents: 1 }]));
  throws(() => analyze([{ month: 1.5, cents: 1 }]));
  throws(() => analyze([{ month: 0, cents: 1.5 }]));
  throws(() => npv([{ month: 0, cents: 1 }], parseRational("1/0")));
});
