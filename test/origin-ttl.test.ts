import { test } from "node:test";
import assert from "node:assert/strict";
import { diffZones, normalizeZone } from "../src/index";

const ORIGIN = "example.com.";

test("omitted owner keeps the previous expanded owner across $ORIGIN changes", () => {
  const before = `
$ORIGIN example.com.
$TTL 300
www 300 A 192.0.2.1
    300 A 192.0.2.2
`;
  const after = `
$ORIGIN other.example.com.
$TTL 600
www.example.com. 300 A 192.0.2.1
         A 192.0.2.2
`;
  const diff = diffZones(ORIGIN, before, after);
  assert.deepEqual(diff.added, [
    { owner: "www.example.com.", type: "A", ttl: 600, rdata: { kind: "A", address: "192.0.2.2" } },
  ]);
  assert.deepEqual(diff.removed, [
    { owner: "www.example.com.", type: "A", ttl: 300, rdata: { kind: "A", address: "192.0.2.2" } },
  ]);
});

test("omitted TTL uses the current $TTL default, not a previous explicit TTL", () => {
  const records = normalizeZone(ORIGIN, "$TTL 300\nwww 9000 A 192.0.2.1\nwww A 192.0.2.2\n");
  assert.deepEqual(
    records.map((r) => r.ttl).sort(),
    [300, 9000],
  );
});

test("omitting TTL without any $TTL default fails the whole operation", () => {
  assert.throws(() => normalizeZone(ORIGIN, "www A 192.0.2.1\n"), /no \$TTL default/);
});

test("omitting owner before any owner was seen fails", () => {
  assert.throws(() => normalizeZone(ORIGIN, "$TTL 300\n  A 192.0.2.1\n"), /omits owner/);
});

test("relative $ORIGIN expands against the old origin", () => {
  const records = normalizeZone(
    ORIGIN,
    "$TTL 300\n$ORIGIN sub\nhost A 192.0.2.1\n$ORIGIN deeper.sub.example.com.\nhost A 192.0.2.2\n",
  );
  assert.deepEqual(
    records.map((r) => r.owner),
    ["host.deeper.sub.example.com.", "host.sub.example.com."],
  );
});

test("TTL change appears as remove of old record plus add of new record", () => {
  const before = "$TTL 300\nwww A 192.0.2.1\n";
  const after = "$TTL 300\nwww 600 A 192.0.2.1\n";
  const diff = diffZones(ORIGIN, before, after);
  assert.equal(diff.added.length, 1);
  assert.equal(diff.removed.length, 1);
  assert.equal(diff.added[0]!.ttl, 600);
  assert.equal(diff.removed[0]!.ttl, 300);
});
