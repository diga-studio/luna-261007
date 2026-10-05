import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGeoIndex, compileDeny, type GeoRow } from "../src/index.ts";
import { cidrEndExclusive, collect, parseCidrTest, parseV6Test } from "./helpers.ts";

async function* rowsOf(list: GeoRow[]): AsyncIterable<GeoRow> {
  yield* list;
}

function toIntervals(cidrs: string[]): { start: bigint; end: bigint }[] {
  return cidrs.map((c) => {
    const p = parseCidrTest(c);
    return { start: p.start, end: cidrEndExclusive(p.start, p.family, p.len) };
  });
}

function isCovered(intervals: { start: bigint; end: bigint }[], addr: bigint): boolean {
  return intervals.some((iv) => addr >= iv.start && addr < iv.end);
}

test("IPv6 /0 minus a single /128 yields exactly 128 segments with full low-bit precision", async () => {
  const protectedAddr = parseV6Test("2001:db8:1234:5678:9abc:def0:1234:5678");
  const index = await buildGeoIndex(rowsOf([{ cidr: "::/0", country: "XX" }]));
  const output = await collect(
    compileDeny(index, ["XX"], ["2001:db8:1234:5678:9abc:def0:1234:5678/128"]),
  );
  assert.equal(output.length, 128);

  // Independently computed expectation: for each bit position, flip that bit.
  const expected: { start: bigint; len: number }[] = [];
  for (let j = 0; j < 128; j++) {
    const len = j + 1;
    const shift = BigInt(128 - len);
    expected.push({ start: ((protectedAddr >> shift) ^ 1n) << shift, len });
  }
  expected.sort((a, b) => (a.start < b.start ? -1 : 1));

  const actual = output.map((c) => {
    const p = parseCidrTest(c);
    assert.equal(p.family, 6);
    return { start: p.start, len: p.len };
  });
  assert.deepEqual(actual, expected);

  // Low-bit precision: neighbours differing only in low bits must be denied,
  // and only the exact protected address is allowed.
  const intervals = toIntervals(output);
  assert.ok(!isCovered(intervals, protectedAddr), "protected address must be allowed");
  assert.ok(isCovered(intervals, protectedAddr + 1n));
  assert.ok(isCovered(intervals, protectedAddr - 1n));
  assert.ok(isCovered(intervals, protectedAddr ^ 1n));
  assert.ok(isCovered(intervals, protectedAddr ^ 0xffn));
  assert.ok(isCovered(intervals, protectedAddr ^ 0xffffffffffffffffn));
  assert.ok(isCovered(intervals, 0n));
  assert.ok(isCovered(intervals, (1n << 128n) - 1n));
});

test("duplicate normalized CIDRs: the last record wins", async () => {
  // Host bits are cleared before dedup: 10.9.7.3/16 normalizes to 10.9.0.0/16.
  const usLast = await buildGeoIndex(
    rowsOf([
      { cidr: "10.9.0.0/16", country: "CN" },
      { cidr: "10.9.7.3/16", country: "US" },
    ]),
  );
  assert.deepEqual(await collect(compileDeny(usLast, ["CN"], [])), []);

  const cnLast = await buildGeoIndex(
    rowsOf([
      { cidr: "10.9.7.3/16", country: "US" },
      { cidr: "10.9.0.0/16", country: "CN" },
    ]),
  );
  assert.deepEqual(await collect(compileDeny(cnLast, ["CN"], [])), ["10.9.0.0/16"]);

  // A non-last duplicate must not win arbitrarily.
  const three = await buildGeoIndex(
    rowsOf([
      { cidr: "2001:db8::/32", country: "CN" },
      { cidr: "2001:db8::/32", country: "JP" },
      { cidr: "2001:db8::/32", country: "US" },
    ]),
  );
  assert.deepEqual(await collect(compileDeny(three, ["CN", "JP"], [])), []);
  assert.deepEqual(await collect(compileDeny(three, ["US"], [])), ["2001:db8::/32"]);
});

test("repeated compiles of one index with different protections do not pollute each other", async () => {
  const index = await buildGeoIndex(
    rowsOf([
      { cidr: "10.0.0.0/8", country: "CN" },
      { cidr: "2001:db8::/32", country: "CN" },
    ]),
  );
  const p1 = ["10.0.0.0/9"];
  const p2 = ["10.64.0.0/10", "2001:db8::/48"];
  const out1 = await collect(compileDeny(index, ["CN"], p1));
  const out2 = await collect(compileDeny(index, ["CN"], p2));
  const out3 = await collect(compileDeny(index, ["CN"], p1));
  assert.deepEqual(out3, out1, "recompiling with the first protection list changed the result");
  assert.notEqual(out1.join("\n"), out2.join("\n"));
  // Index arrays remain untouched.
  assert.equal(index.v4.length, 1);
  assert.equal(index.v6.length, 1);
});

test("IPv4-mapped IPv6 records stay in the IPv6 space", async () => {
  const index = await buildGeoIndex(rowsOf([{ cidr: "::ffff:10.0.0.0/104", country: "CN" }]));
  const output = await collect(compileDeny(index, ["CN"], []));
  assert.equal(output.length, 1);
  const parsed = parseCidrTest(output[0]);
  assert.equal(parsed.family, 6);
  assert.equal(parsed.start, (0xffffn << 32n) | 0x0a000000n);
  assert.equal(parsed.len, 104);
});

test("compile output is produced incrementally", async () => {
  const records: GeoRow[] = [];
  for (let i = 0; i < 2000; i++) {
    records.push({ cidr: `10.${(i >> 1) & 0xff}.${(i & 1) * 2}.0/24`, country: "CN" });
  }
  const index = await buildGeoIndex(rowsOf(records));
  const it = compileDeny(index, ["CN"], [])[Symbol.asyncIterator]();
  const first = await it.next();
  const second = await it.next();
  assert.equal(first.done, false);
  assert.equal(second.done, false);
  assert.equal(first.value, "10.0.0.0/24");
  assert.equal(second.value, "10.0.2.0/24");
});
