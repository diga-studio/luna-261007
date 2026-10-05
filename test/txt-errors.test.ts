import { test } from "node:test";
import assert from "node:assert/strict";
import { diffZones, normalizeZone, ZoneParseError } from "../src/index";

const ORIGIN = "example.com.";

test("TXT escapes: quoted chars, semicolons, parens and decimal bytes", () => {
  const records = normalizeZone(
    ORIGIN,
    `$TTL 300
t1 TXT "a\\"b;c(d)e)"
t2 TXT "\\065\\066\\067"
t3 TXT ( "multi"
          "line" )
`,
  );
  const byOwner = new Map(records.map((r) => [r.owner, r]));
  assert.deepEqual(byOwner.get("t1.example.com.")!.rdata, { kind: "TXT", strings: ['a"b;c(d)e)'] });
  assert.deepEqual(byOwner.get("t2.example.com.")!.rdata, { kind: "TXT", strings: ["ABC"] });
  assert.deepEqual(byOwner.get("t3.example.com.")!.rdata, { kind: "TXT", strings: ["multi", "line"] });
});

test("TXT fragments are compared as an ordered list, never concatenated", () => {
  const before = "$TTL 300\nt TXT \"ab\" \"c\"\n";
  const after = "$TTL 300\nt TXT \"a\" \"bc\"\n";
  const diff = diffZones(ORIGIN, before, after);
  assert.equal(diff.added.length, 1);
  assert.equal(diff.removed.length, 1);
  assert.deepEqual(diff.added[0]!.rdata, { kind: "TXT", strings: ["a", "bc"] });
  assert.deepEqual(diff.removed[0]!.rdata, { kind: "TXT", strings: ["ab", "c"] });
});

test("TXT comparison is case-sensitive", () => {
  const diff = diffZones(ORIGIN, "$TTL 300\nt TXT \"Ab\"\n", "$TTL 300\nt TXT \"aB\"\n");
  assert.equal(diff.added.length, 1);
  assert.equal(diff.removed.length, 1);
});

test("unterminated quote fails the whole operation with no partial result", () => {
  assert.throws(
    () => normalizeZone(ORIGIN, "$TTL 300\ngood A 192.0.2.1\nbad TXT \"oops\n"),
    ZoneParseError,
  );
  assert.throws(
    () => diffZones(ORIGIN, "$TTL 300\nok A 192.0.2.1\n", "$TTL 300\nbad TXT \"oops\n"),
    ZoneParseError,
  );
});

test("unclosed parenthesis fails the whole operation", () => {
  assert.throws(
    () => normalizeZone(ORIGIN, "$TTL 300\nbad TXT ( \"a\"\n\"b\"\n"),
    /unclosed/,
  );
});

test("bare newline inside a quoted string fails", () => {
  assert.throws(() => normalizeZone(ORIGIN, "$TTL 300\nt TXT \"a\nb\"\n"), /bare newline/);
});

test("out-of-range and malformed numeric escapes fail", () => {
  assert.throws(() => normalizeZone(ORIGIN, "$TTL 300\nt TXT \"\\256\"\n"), /out of range/);
  assert.throws(() => normalizeZone(ORIGIN, "$TTL 300\nt TXT \"\\12x\"\n"), /three digits/);
  assert.throws(() => normalizeZone(ORIGIN, "$TTL 300\nt TXT \"\\12\"\n"), /three digits/);
});

test("unmatched closing parenthesis fails", () => {
  assert.throws(() => normalizeZone(ORIGIN, "$TTL 300\nt TXT \"a\" )\n"), /unmatched/);
});

test("unsupported directives and record types fail", () => {
  assert.throws(() => normalizeZone(ORIGIN, "$TTL 300\n$INCLUDE other.zone\n"), /unsupported directive/);
  assert.throws(() => normalizeZone(ORIGIN, "$TTL 300\nwww CAA 0 issue \"ca.example\"\n"), /unsupported record type/);
});

test("non-IN class fails", () => {
  assert.throws(() => normalizeZone(ORIGIN, "$TTL 300\nwww CH A 192.0.2.1\n"), /unsupported record type/);
});

test("a parse error in either snapshot aborts the diff entirely", () => {
  const good = "$TTL 300\nwww A 192.0.2.1\n";
  const broken = "$TTL 300\nwww A 192.0.2.1\nbad TXT ( \"x\"\n";
  assert.throws(() => diffZones(ORIGIN, good, broken), ZoneParseError);
  assert.throws(() => diffZones(ORIGIN, broken, good), ZoneParseError);
});
