import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import {
  makeRational,
  parseRational,
  add,
  mul,
  div,
  cmp,
  sign,
  isZero,
  toString,
} from "../src/rational.js";

test("rationals are normalized", () => {
  equal(toString(makeRational(6n, 4n)), "3/2");
  equal(toString(makeRational(-6n, 4n)), "-3/2");
  equal(toString(makeRational(6n, -4n)), "-3/2");
  equal(toString(makeRational(0n, 99n)), "0");
  equal(toString(makeRational(10n, 5n)), "2");
});

test("parseRational handles integers, fractions and decimals exactly", () => {
  equal(toString(parseRational("3")), "3");
  equal(toString(parseRational("-7/2")), "-7/2");
  equal(toString(parseRational("1.2")), "6/5");
  equal(toString(parseRational("0.0000000001")), "1/10000000000");
  equal(toString(parseRational("-0.5")), "-1/2");
  equal(toString(parseRational("1.20000012")), "30000003/25000000");
});

test("arithmetic is exact", () => {
  const third = parseRational("1/3");
  const sixth = parseRational("1/6");
  equal(toString(add(third, sixth)), "1/2");
  equal(toString(mul(third, third)), "1/9");
  equal(toString(div(third, sixth)), "2");
  ok(isZero(add(third, makeRational(-1n, 3n))));
  ok(cmp(parseRational("0.1"), parseRational("1/10")) === 0);
  ok(sign(parseRational("-0.0001")) === -1);
});
