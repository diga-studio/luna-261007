import { test } from "node:test";
import assert from "node:assert/strict";
import { diffZones, normalizeZone } from "../src/index.ts";

const BEFORE = [
  "$ORIGIN example.com.",
  "$TTL 300",
  "www IN A 192.0.2.1",
  "  IN AAAA 2001:db8::1",
  "$ORIGIN sub.example.com.",
  "$TTL 600",
  "mail IN A 192.0.2.2",
  '  IN TXT "v1"',
  "",
].join("\n");

test("omitted owner keeps previous absolute owner across directives", () => {
  const records = normalizeZone("example.com.", BEFORE);
  const aaaa = records.find((r) => r.type === "AAAA");
  const txt = records.find((r) => r.type === "TXT");
  const mailA = records.find((r) => r.type === "A" && r.owner.startsWith("mail"));
  // Owner survives $ORIGIN/$TTL directives in between.
  assert.equal(aaaa!.owner, "www.example.com.");
  assert.equal(txt!.owner, "mail.sub.example.com.");
  // TTL comes from the current $TTL default, not the previous record.
  assert.equal(aaaa!.ttl, 300);
  assert.equal(mailA!.ttl, 600);
  assert.equal(txt!.ttl, 600);
});

test("only the real change appears in the diff", () => {
  const after = BEFORE.replace('"v1"', '"v2"');
  const diff = diffZones("example.com.", BEFORE, after);
  assert.equal(diff.added.length, 1);
  assert.equal(diff.removed.length, 1);
  const added = diff.added[0]!;
  const removed = diff.removed[0]!;
  assert.equal(added.owner, "mail.sub.example.com.");
  assert.equal(removed.owner, "mail.sub.example.com.");
  assert.equal(added.ttl, 600);
  assert.equal(removed.ttl, 600);
  assert.equal(added.type, "TXT");
  assert.deepEqual(
    added.rdata,
    { kind: "TXT", chunks: [new Uint8Array([0x76, 0x32])] },
  );
});

test("relative $ORIGIN expands against the old origin", () => {
  const text = [
    "$ORIGIN example.com.",
    "$TTL 300",
    "$ORIGIN sub",
    "host IN A 192.0.2.9",
    "$ORIGIN deep.sub.example.com.",
    "host IN A 192.0.2.10",
    "",
  ].join("\n");
  const records = normalizeZone("example.com.", text);
  assert.equal(records[0]!.owner, "host.deep.sub.example.com.");
  assert.equal(records[1]!.owner, "host.sub.example.com.");
});

test("duplicate records do not affect the diff", () => {
  const single = "$TTL 300\nwww A 192.0.2.1\n";
  const doubled = "$TTL 300\nwww A 192.0.2.1\nwww A 192.0.2.1\nwww A 192.0.2.1\n";
  assert.deepEqual(diffZones("example.com.", single, doubled), {
    added: [],
    removed: [],
  });
});

test("add and remove of whole records", () => {
  const before = "$TTL 300\nwww A 192.0.2.1\nold A 192.0.2.2\n";
  const after = "$TTL 300\nwww A 192.0.2.1\nnew AAAA 2001:db8::5\n";
  const diff = diffZones("example.com.", before, after);
  assert.equal(diff.added.length, 1);
  assert.equal(diff.removed.length, 1);
  assert.equal(diff.added[0]!.owner, "new.example.com.");
  assert.equal(diff.added[0]!.type, "AAAA");
  assert.equal(diff.removed[0]!.owner, "old.example.com.");
  assert.equal(diff.removed[0]!.type, "A");
});
