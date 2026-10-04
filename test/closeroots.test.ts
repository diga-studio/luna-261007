import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { analyze, npv } from "../src/apr.js";
import { parseRational, isZero } from "../src/rational.js";
import { checkCandidatesWellFormed, contains } from "./helpers.js";

// R(t) = (t - 1)(200000000000 t - 200000000001)
//      = 200000000000 t^2 - 400000000001 t + 200000000001
// t-roots: 1 (APR 0, range endpoint) and 1 + 1/200000000000
// (APR 0.00000000006). The roots are 6e-11 apart in APR, closer than the
// 1e-10 width bound, so the isolating intervals must shrink below 1e-10
// to stay disjoint.
const cashflows = [
  { month: 0, cents: 200000000000n },
  { month: 1, cents: -400000000001n },
  { month: 2, cents: 200000000001n },
];

test("roots closer than 1e-10 are still isolated separately", () => {
  const result = analyze(cashflows);
  equal(result.kind, "finite");
  if (result.kind !== "finite") return;
  equal(result.candidates.length, 2);
  equal(result.candidates[0].multiplicity, 1);
  equal(result.candidates[1].multiplicity, 1);
  ok(contains(result.candidates[0], "0"), "first interval must contain 0");
  ok(
    contains(result.candidates[1], "0.00000000006"),
    "second interval must contain 0.00000000006",
  );
  checkCandidatesWellFormed(result.candidates);

  ok(isZero(npv(cashflows, parseRational("0"))));
  ok(isZero(npv(cashflows, parseRational("0.00000000006"))));
});
