import { test } from "node:test";
import assert from "node:assert/strict";
import { diffZones, normalizeZone } from "../src/index";

const ORIGIN = "example.com.";

test("equivalent spellings of the same snapshot produce an empty diff", () => {
  const before = `
$ORIGIN example.com.
$TTL 1h
www     3600    IN A     192.0.2.1
www     3600    IN A     192.0.2.1   ; exact duplicate
WWW     1h      IN A     192.0.2.1   ; duplicate via unit + case
@       IN      MX 10 mail.example.com.
mail    1h      A      192.0.2.2
alias   3600    CNAME  www
v6host  3600    AAAA   2001:db8::1
txt     3600    TXT ( "hello"
                        "world" )    ; multiline record
`;
  const after = `
$ORIGIN EXAMPLE.COM.
$TTL 3600
WWW.EXAMPLE.COM.  1h   A   192.0.2.1
@                 60m  IN MX 10 mail
mail.example.com. 3600 A   192.0.2.2
ALIAS             1h   CNAME WWW.EXAMPLE.COM.
v6host            3600 AAAA 2001:0db8:0000:0000:0000:0000:0000:0001
TXT               3600 TXT "hello" "world"
`;
  const diff = diffZones(ORIGIN, before, after);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
});

test("CRLF and LF line endings normalize identically", () => {
  const lf = "$ORIGIN example.com.\n$TTL 300\nwww A 192.0.2.1\n";
  const crlf = lf.replace(/\n/g, "\r\n");
  assert.deepEqual(normalizeZone(ORIGIN, lf), normalizeZone(ORIGIN, crlf));
});

test("duplicate record multiplicity does not affect the diff", () => {
  const before = "$TTL 300\nwww A 192.0.2.1\nwww A 192.0.2.1\nwww A 192.0.2.1\n";
  const after = "$TTL 300\nwww A 192.0.2.1\n";
  const diff = diffZones(ORIGIN, before, after);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
});

test("normalization deduplicates and orders deterministically", () => {
  const a = normalizeZone(ORIGIN, "$TTL 300\nb A 192.0.2.2\na A 192.0.2.1\na A 192.0.2.1\n");
  const b = normalizeZone(ORIGIN, "$TTL 300\na A 192.0.2.1\nb A 192.0.2.2\n");
  assert.deepEqual(a, b);
  assert.equal(a.length, 2);
  assert.equal(a[0]!.owner, "a.example.com.");
  assert.equal(a[1]!.owner, "b.example.com.");
});
