import { test } from "node:test";
import assert from "node:assert/strict";
import { diffZones, normalizeZone } from "../src/index";

const ORIGIN = "example.com.";

test("TTL and IN may appear in either order", () => {
  const a = normalizeZone(ORIGIN, "$TTL 300\nwww IN 300 A 192.0.2.1\n");
  const b = normalizeZone(ORIGIN, "$TTL 300\nwww 300 IN A 192.0.2.1\n");
  const c = normalizeZone(ORIGIN, "$TTL 300\nwww IN A 192.0.2.1\n");
  assert.deepEqual(a, b);
  assert.deepEqual(a, c);
});

test("@ refers to the current origin for owner and targets", () => {
  const records = normalizeZone(
    ORIGIN,
    "$TTL 300\n$ORIGIN example.com.\n@ NS ns1\n$ORIGIN sub.example.com.\n@ NS @\n",
  );
  assert.deepEqual(records, [
    { owner: "example.com.", type: "NS", ttl: 300, rdata: { kind: "NS", target: "ns1.example.com." } },
    { owner: "sub.example.com.", type: "NS", ttl: 300, rdata: { kind: "NS", target: "sub.example.com." } },
  ]);
});

test("IPv4 addresses compare as four decimal octets", () => {
  const diff = diffZones(ORIGIN, "$TTL 300\nwww A 192.0.2.1\n", "$TTL 300\nwww A 192.0.2.2\n");
  assert.equal(diff.added.length, 1);
  assert.equal(diff.removed.length, 1);
  assert.deepEqual(
    diffZones(ORIGIN, "$TTL 300\nwww A 192.0.02.1\n", "$TTL 300\nwww A 192.0.2.1\n"),
    { added: [], removed: [] },
  );
});

test("IPv6 addresses compare as 128-bit values across spellings", () => {
  const spellings = [
    "2001:db8::1",
    "2001:0DB8:0:0:0:0:0:1",
    "2001:0db8:0000:0000:0000:0000:0000:0001",
  ];
  for (const other of spellings) {
    assert.deepEqual(
      diffZones(ORIGIN, `$TTL 300\nh AAAA ${spellings[0]}\n`, `$TTL 300\nh AAAA ${other}\n`),
      { added: [], removed: [] },
    );
  }
  const changed = diffZones(ORIGIN, "$TTL 300\nh AAAA 2001:db8::1\n", "$TTL 300\nh AAAA 2001:db8::2\n");
  assert.equal(changed.added.length, 1);
  assert.equal(changed.removed.length, 1);
});

test("IPv4-mapped IPv6 forms are accepted", () => {
  assert.deepEqual(
    diffZones(ORIGIN, "$TTL 300\nh AAAA ::ffff:192.0.2.1\n", "$TTL 300\nh AAAA 0:0:0:0:0:ffff:c000:0201\n"),
    { added: [], removed: [] },
  );
});

test("MX preference participates in comparison", () => {
  const diff = diffZones(ORIGIN, "$TTL 300\n@ MX 10 mail\n", "$TTL 300\n@ MX 20 mail\n");
  assert.equal(diff.added.length, 1);
  assert.equal(diff.removed.length, 1);
  assert.deepEqual(diff.added[0]!.rdata, { kind: "MX", preference: 20, exchange: "mail.example.com." });
});

test("CNAME and NS targets expand against the current origin", () => {
  const records = normalizeZone(
    ORIGIN,
    "$TTL 300\n$ORIGIN example.com.\nalias CNAME www\n@ NS ns1.example.net.\n$ORIGIN sub\nalias2 CNAME www\n",
  );
  const cnames = records.filter((r) => r.type === "CNAME");
  assert.deepEqual(cnames[0]!.rdata, { kind: "CNAME", target: "www.example.com." });
  assert.deepEqual(cnames[1]!.rdata, { kind: "CNAME", target: "www.sub.example.com." });
  const ns = records.find((r) => r.type === "NS")!;
  assert.deepEqual(ns.rdata, { kind: "NS", target: "ns1.example.net." });
});

test("a 255-byte TXT string is accepted, 256 bytes rejected", () => {
  const ok = "a".repeat(255);
  const tooLong = "a".repeat(256);
  assert.equal(normalizeZone(ORIGIN, `$TTL 300\nt TXT "${ok}"\n`).length, 1);
  assert.throws(() => normalizeZone(ORIGIN, `$TTL 300\nt TXT "${tooLong}"\n`), /255 bytes/);
});

test("real changes never vanish: mixed snapshots diff precisely", () => {
  const before = `
$TTL 300
keep   A    192.0.2.1
drop   A    192.0.2.2
mod    A    192.0.2.3
ttl    300  A 192.0.2.4
`;
  const after = `
$TTL 300
keep   A    192.0.2.1
mod    A    192.0.2.30
ttl    600  A 192.0.2.4
new    TXT  "hello"
`;
  const diff = diffZones(ORIGIN, before, after);
  const owners = (rs: readonly { owner: string; ttl: number }[]) => rs.map((r) => `${r.owner}:${r.ttl}`).sort();
  assert.deepEqual(owners(diff.added), ["mod.example.com.:300", "new.example.com.:300", "ttl.example.com.:600"]);
  assert.deepEqual(owners(diff.removed), ["drop.example.com.:300", "mod.example.com.:300", "ttl.example.com.:300"]);
});
