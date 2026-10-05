import test from "node:test";
import assert from "node:assert/strict";
import { mulDivRound, parseDecimal, parseInteger } from "../src/decimal";

function convert(input: string, numerator: string, denominator: string, scale: number): string {
  const value = parseDecimal(input);
  const num = parseInteger(numerator);
  const den = parseInteger(denominator);
  assert.ok(value !== null && num !== null && den !== null);
  return mulDivRound(value, num, den, scale);
}

test("parses plain decimal strings and rejects exponents", () => {
  assert.ok(parseDecimal("123.45") !== null);
  assert.ok(parseDecimal("-0.001") !== null);
  assert.ok(parseDecimal("+7") !== null);
  assert.equal(parseDecimal("1e3"), null);
  assert.equal(parseDecimal("1.2.3"), null);
  assert.equal(parseDecimal(""), null);
  assert.equal(parseDecimal("abc"), null);
  assert.equal(parseDecimal(12), null);
});

test("keeps 30 significant digits exactly", () => {
  assert.equal(
    convert("123456789012345678901234567890", "1", "1", 0),
    "123456789012345678901234567890",
  );
  assert.equal(
    convert("123456789012345678901234567890", "3", "2", 0),
    "185185183518518518351851851835",
  );
});

test("keeps 12 decimal places through multiplication and division", () => {
  assert.equal(
    convert("123456789012345678.901234567890", "2", "3", 6),
    "82304526008230452.600823",
  );
  assert.equal(convert("0.000000000001", "1", "1", 12), "0.000000000001");
  assert.equal(convert("999999999999.999999999999", "1", "1", 6), "1000000000000.000000");
});

test("rounds positive midpoints to even last digit", () => {
  assert.equal(convert("0.0000005", "1", "1", 6), "0.000000");
  assert.equal(convert("0.0000015", "1", "1", 6), "0.000002");
  assert.equal(convert("2.5", "1", "1", 0), "2");
  assert.equal(convert("3.5", "1", "1", 0), "4");
  assert.equal(convert("0.25", "1", "1", 1), "0.2");
  assert.equal(convert("0.35", "1", "1", 1), "0.4");
  assert.equal(convert("0.05", "3", "2", 1), "0.1");
});

test("rounds negative midpoints to even last digit", () => {
  assert.equal(convert("-0.0000005", "1", "1", 6), "0.000000");
  assert.equal(convert("-0.0000015", "1", "1", 6), "-0.000002");
  assert.equal(convert("-2.5", "1", "1", 0), "-2");
  assert.equal(convert("-3.5", "1", "1", 0), "-4");
});

test("turns negative zero into positive zero", () => {
  assert.equal(convert("-0.0000001", "1", "1", 6), "0.000000");
  assert.equal(convert("-0", "5", "1", 2), "0.00");
  assert.equal(convert("0.0000004", "1", "1", 6), "0.000000");
});

test("keeps the requested fraction digits and supports scale 0-6", () => {
  assert.equal(convert("1", "1", "3", 6), "0.333333");
  assert.equal(convert("1", "1", "3", 0), "0");
  assert.equal(convert("2", "1", "1", 4), "2.0000");
  assert.equal(convert("-7.5", "1", "1", 3), "-7.500");
});

test("handles negative numerator", () => {
  assert.equal(convert("4", "-3", "2", 1), "-6.0");
});
