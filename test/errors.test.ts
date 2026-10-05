import { test } from "node:test";
import assert from "node:assert/strict";
import { diffZones, normalizeZone, ZoneParseError } from "../src/index.ts";

test("TXT with escaped quote, semicolon, paren and decimal byte", () => {
  // Decoded content: a"b;c(d)e<TAB> (10 bytes)
  const a = '$TTL 300\nt TXT "a\\"b;c(d)e\\009"\n';
  const b = '$TTL 300\nt TXT "a\\034b;c(d)e\t"\n';
  // Different spellings, same bytes: no diff.
  assert.deepEqual(diffZones("example.com.", a, b), {
    added: [],
    removed: [],
  });
  const records = normalizeZone("example.com.", a);
  assert.deepEqual(records[0]!.rdata, {
    kind: "TXT",
    chunks: [
      new Uint8Array([0x61, 0x22, 0x62, 0x3b, 0x63, 0x28, 0x64, 0x29, 0x65, 0x09]),
    ],
  });
});

test("semicolons and parens inside quotes are data, not syntax", () => {
  const text = '$TTL 300\nt TXT ";" "(" ")" "\\\\"\n';
  const records = normalizeZone("example.com.", text);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0]!.rdata, {
    kind: "TXT",
    chunks: [
      new Uint8Array([0x3b]),
      new Uint8Array([0x28]),
      new Uint8Array([0x29]),
      new Uint8Array([0x5c]),
    ],
  });
});

test("unterminated quote fails the whole operation", () => {
  assert.throws(
    () => normalizeZone("example.com.", '$TTL 300\nwww A 192.0.2.1\nt TXT "abc\n'),
    ZoneParseError,
  );
});

test("unclosed parenthesis fails the whole operation", () => {
  const broken = '$TTL 300\nwww A 192.0.2.1\nt TXT ( "abc"\n';
  assert.throws(() => normalizeZone("example.com.", broken), ZoneParseError);
  // diffZones fails as a whole: no partial diff is returned.
  assert.throws(
    () => diffZones("example.com.", "$TTL 300\nwww A 192.0.2.1\n", broken),
    ZoneParseError,
  );
});

test("unmatched closing parenthesis fails", () => {
  assert.throws(
    () => normalizeZone("example.com.", "$TTL 300\nwww A 192.0.2.1 )\n"),
    ZoneParseError,
  );
});

test("bad decimal escapes fail", () => {
  assert.throws(
    () => normalizeZone("example.com.", '$TTL 300\nt TXT "a\\25"\n'),
    ZoneParseError,
  );
  assert.throws(
    () => normalizeZone("example.com.", '$TTL 300\nt TXT "a\\256"\n'),
    ZoneParseError,
  );
});

test("oversized TXT chunk fails", () => {
  const chunk = "x".repeat(256);
  assert.throws(
    () => normalizeZone("example.com.", `$TTL 300\nt TXT "${chunk}"\n`),
    ZoneParseError,
  );
});

test("missing $TTL default with omitted TTL fails", () => {
  assert.throws(
    () => normalizeZone("example.com.", "www A 192.0.2.1\n"),
    ZoneParseError,
  );
});

test("unsupported directives and record types fail", () => {
  assert.throws(
    () => normalizeZone("example.com.", "$TTL 300\n$INCLUDE other.zone\n"),
    ZoneParseError,
  );
  assert.throws(
    () => normalizeZone("example.com.", "$TTL 300\nwww AAAA ::1\nx SRV 0 0 80 www\n"),
    ZoneParseError,
  );
});

test("non-IN class fails", () => {
  assert.throws(
    () => normalizeZone("example.com.", "$TTL 300\nwww CH A 192.0.2.1\n"),
    ZoneParseError,
  );
});

test("invalid addresses fail", () => {
  assert.throws(
    () => normalizeZone("example.com.", "$TTL 300\nwww A 192.0.2.256\n"),
    ZoneParseError,
  );
  assert.throws(
    () => normalizeZone("example.com.", "$TTL 300\nwww AAAA 2001:::1\n"),
    ZoneParseError,
  );
});

test("owner omitted before any record fails", () => {
  assert.throws(
    () => normalizeZone("example.com.", "$TTL 300\n  A 192.0.2.1\n"),
    ZoneParseError,
  );
});
