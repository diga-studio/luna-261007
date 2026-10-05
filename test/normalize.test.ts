import { test } from "node:test";
import assert from "node:assert/strict";
import { diffZones, normalizeZone } from "../src/index.ts";

test("equivalent spellings produce an empty diff", () => {
  const before = [
    "$ORIGIN example.com.",
    "$TTL 3600",
    "www 300 IN A 192.0.2.1",
    "www 300 IN A 192.0.2.1 ; duplicate record",
    "mail IN MX 10 mx1.example.com.",
    "@ IN NS ns1.example.com.",
    "web CNAME www",
    'txt TXT "hello" "world"',
    "v6 AAAA 2001:db8::1",
    "",
  ].join("\n");
  const after = [
    "$TTL 1H",
    "WWW.EXAMPLE.COM. 5M A 192.0.2.1 ; absolute name, case, TTL unit",
    "mail.example.com. in mx 10 mx1 ; lowercase class/type, relative target",
    "@ 3600 NS ns1",
    "web.example.com. 3600 IN CNAME www.example.com.",
    'txt.example.com. TXT ( "hello" ; multi-line with comment',
    '  "world" )',
    "v6 aaaa 2001:0DB8:0000:0000:0000:0000:0000:0001",
    "",
  ].join("\r\n"); // CRLF line endings
  const diff = diffZones("example.com.", before, after);
  assert.deepEqual(diff, { added: [], removed: [] });
});

test("normalizeZone deduplicates and sorts deterministically", () => {
  const text = [
    "$TTL 300",
    "b A 192.0.2.2",
    "a A 192.0.2.1",
    "b A 192.0.2.2",
    "b A 192.0.2.2",
  ].join("\n");
  const records = normalizeZone("example.com.", text);
  assert.equal(records.length, 2);
  assert.equal(records[0]!.owner, "a.example.com.");
  assert.equal(records[1]!.owner, "b.example.com.");
  // Same semantics in different order give identical output.
  const shuffled = normalizeZone(
    "example.com.",
    ["$TTL 5m", "b A 192.0.2.2", "a A 192.0.2.1"].join("\n"),
  );
  assert.deepEqual(records, shuffled);
});

test("TXT chunk boundaries are significant", () => {
  const before = '$TTL 300\nt TXT "ab" "c"\n';
  const after = '$TTL 300\nt TXT "a" "bc"\n';
  const diff = diffZones("example.com.", before, after);
  assert.equal(diff.added.length, 1);
  assert.equal(diff.removed.length, 1);
});

test("TXT comparison is case sensitive", () => {
  const diff = diffZones(
    "example.com.",
    '$TTL 300\nt TXT "Hello"\n',
    '$TTL 300\nt TXT "hello"\n',
  );
  assert.equal(diff.added.length, 1);
  assert.equal(diff.removed.length, 1);
});

test("MX preference participates in comparison", () => {
  const diff = diffZones(
    "example.com.",
    "$TTL 300\nmail MX 10 mx\n",
    "$TTL 300\nmail MX 20 mx\n",
  );
  assert.equal(diff.added.length, 1);
  assert.equal(diff.removed.length, 1);
});

test("TTL change is a remove plus an add", () => {
  const diff = diffZones(
    "example.com.",
    "$TTL 300\nwww 300 A 192.0.2.1\n",
    "$TTL 300\nwww 301 A 192.0.2.1\n",
  );
  assert.equal(diff.added.length, 1);
  assert.equal(diff.removed.length, 1);
  assert.equal(diff.added[0]!.ttl, 301);
  assert.equal(diff.removed[0]!.ttl, 300);
});
