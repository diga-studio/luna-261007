import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDateTime } from "../src/datetime";

test("normalizes UTC marker to fixed 3-digit fraction", () => {
  assert.equal(normalizeDateTime("2024-05-06T01:02:03Z"), "2024-05-06T01:02:03.000Z");
  assert.equal(normalizeDateTime("2024-05-06T01:02:03.4Z"), "2024-05-06T01:02:03.400Z");
  assert.equal(normalizeDateTime("2024-05-06T01:02:03.45Z"), "2024-05-06T01:02:03.450Z");
  assert.equal(normalizeDateTime("2024-05-06T01:02:03.456Z"), "2024-05-06T01:02:03.456Z");
});

test("converts numeric offsets across day boundaries", () => {
  assert.equal(normalizeDateTime("2024-03-10T08:30:00+08:00"), "2024-03-10T00:30:00.000Z");
  assert.equal(normalizeDateTime("2024-01-01T00:30:00+08:00"), "2023-12-31T16:30:00.000Z");
  assert.equal(normalizeDateTime("2023-12-31T20:00:00-05:00"), "2024-01-01T01:00:00.000Z");
  assert.equal(normalizeDateTime("2024-03-01T00:30:00+01:00"), "2024-02-29T23:30:00.000Z");
  assert.equal(normalizeDateTime("2023-03-01T00:30:00+01:00"), "2023-02-28T23:30:00.000Z");
});

test("accepts offsets with fraction and normalizes them", () => {
  assert.equal(normalizeDateTime("2024-06-01T12:00:00.789+05:30"), "2024-06-01T06:30:00.789Z");
  assert.equal(normalizeDateTime("2024-06-01T00:15:00-00:30"), "2024-06-01T00:45:00.000Z");
});

test("rejects invalid calendar dates without rolling over", () => {
  assert.equal(normalizeDateTime("2023-02-29T00:00:00Z"), null);
  assert.equal(normalizeDateTime("2024-02-30T00:00:00Z"), null);
  assert.equal(normalizeDateTime("2024-04-31T00:00:00Z"), null);
  assert.equal(normalizeDateTime("2024-13-01T00:00:00Z"), null);
  assert.equal(normalizeDateTime("2024-00-10T00:00:00Z"), null);
  assert.equal(normalizeDateTime("2024-05-00T00:00:00Z"), null);
  assert.equal(normalizeDateTime("2024-02-29T12:00:00Z"), "2024-02-29T12:00:00.000Z");
});

test("rejects leap seconds and out-of-range times", () => {
  assert.equal(normalizeDateTime("2024-06-30T23:59:60Z"), null);
  assert.equal(normalizeDateTime("2024-06-30T24:00:00Z"), null);
  assert.equal(normalizeDateTime("2024-06-30T23:60:00Z"), null);
});

test("rejects timestamps without a timezone", () => {
  assert.equal(normalizeDateTime("2024-05-06T01:02:03"), null);
  assert.equal(normalizeDateTime("2024-05-06 01:02:03Z"), null);
});

test("rejects malformed fractions, offsets and non-strings", () => {
  assert.equal(normalizeDateTime("2024-05-06T01:02:03.4567Z"), null);
  assert.equal(normalizeDateTime("2024-05-06T01:02:03+0800"), null);
  assert.equal(normalizeDateTime("2024-05-06T01:02:03+24:00"), null);
  assert.equal(normalizeDateTime("2024-05-06T01:02:03+08:60"), null);
  assert.equal(normalizeDateTime(1720000000), null);
  assert.equal(normalizeDateTime(null), null);
});
