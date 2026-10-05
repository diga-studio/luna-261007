import { test } from "node:test";
import assert from "node:assert/strict";
import { BillingLedger, Change } from "../src/index";

const T = (iso: string) => Date.parse(`${iso}Z`);

function running(
  instanceId: string,
  changeId: string,
  revision: number,
  at: number,
  tier: "starter" | "growth" | "enterprise" = "starter",
  cpu = 1
): Change {
  return { instanceId, changeId, revision, at, snapshot: { state: "running", tier, cpu } };
}

function state(
  instanceId: string,
  changeId: string,
  revision: number,
  at: number,
  s: "provisioning" | "paused" | "terminated",
  tier: "starter" | "growth" | "enterprise" = "starter",
  cpu = 1
): Change {
  return { instanceId, changeId, revision, at, snapshot: { state: s, tier, cpu } };
}

test("leap-year February: prorated by actual month length across the boundary", () => {
  const l = new BillingLedger();
  // running 2024-02-28T12:00Z -> 2024-03-01T12:00Z (12h in Feb, 12h in Mar)
  l.putChange(running("i-1", "c1", 1, T("2024-02-28T12:00:00")));
  l.putChange(state("i-1", "c2", 1, T("2024-03-01T12:00:00"), "terminated"));
  l.settle(T("2024-03-02T00:00:00"));
  // Feb 2024 has 29 days; Feb 28 12:00 -> Mar 1 00:00 is 36h in February:
  // 2900 * 36h / (29*24h) = 150 exactly
  assert.equal(l.readBill("i-1", "2024-02"), 150);
  // Mar 2024 has 31 days: 2900 * 12h / (31*24h) = 2900/62 = 46.774... -> 47
  assert.equal(l.readBill("i-1", "2024-03"), 47);
  l.close();
});

test("short fragments: exact accumulation, rounding only on the month total", () => {
  const l = new BillingLedger();
  const t0 = T("2024-02-10T00:00:00");
  const t1 = T("2024-02-20T00:00:00");
  // growth (9900c/mo, baseline 4) with cpu 5 -> +1 unit at 500c/hour.
  // Two running fragments of exactly 2880ms each.
  // Per fragment: base 9900*2880/2505600000 = 0.01138c, cpu 500*2880/3600000 = 0.4c.
  // Per-fragment rounding would give 0 + 0 = 0; exact month total is
  // 0.82276c -> rounds to 1.
  l.putChange(running("i-3", "c1", 1, t0, "growth", 5));
  l.putChange(state("i-3", "c2", 1, t0 + 2880, "paused", "growth", 5));
  l.putChange(running("i-3", "c3", 1, t1, "growth", 5));
  l.putChange(state("i-3", "c4", 1, t1 + 2880, "paused", "growth", 5));
  l.settle(T("2024-03-01T00:00:00"));
  assert.equal(l.readBill("i-3", "2024-02"), 1);
  l.close();
});

test("exactly half a cent rounds up", () => {
  const l = new BillingLedger();
  const start = T("2024-02-05T00:00:00");
  // starter cpu 1: 2900 * 432000ms / 2505600000ms = 0.5c exactly -> 1
  l.putChange(running("i-a", "c1", 1, start));
  l.putChange(state("i-a", "c2", 1, start + 432_000, "paused"));
  // 431999ms -> 0.4999988...c -> 0
  l.putChange(running("i-b", "c1", 1, start));
  l.putChange(state("i-b", "c2", 1, start + 431_999, "paused"));
  l.settle(T("2024-03-01T00:00:00"));
  assert.equal(l.readBill("i-a", "2024-02"), 1);
  assert.equal(l.readBill("i-b", "2024-02"), 0);
  l.close();
});

test("provisioning, paused and terminated are free", () => {
  const l = new BillingLedger();
  l.putChange(state("i-f", "c1", 1, T("2024-02-01T00:00:00"), "provisioning", "enterprise", 16));
  l.putChange(state("i-f", "c2", 1, T("2024-02-10T00:00:00"), "paused", "enterprise", 16));
  l.putChange(state("i-f", "c3", 1, T("2024-02-20T00:00:00"), "terminated", "enterprise", 16));
  l.settle(T("2024-04-01T00:00:00"));
  assert.equal(l.readBill("i-f", "2024-02"), 0);
  assert.equal(l.readBill("i-f", "2024-03"), 0);
  assert.equal(l.ledgerRowCount(), 0);
  l.close();
});

test("extra CPU beyond tier baseline billed per unit-hour", () => {
  const l = new BillingLedger();
  // enterprise: baseline 8, cpu 16 -> 8 extra units * 500c = 4000c/hour.
  // One running hour in April 2024 (30 days).
  l.putChange(running("i-e", "c1", 1, T("2024-04-10T00:00:00"), "enterprise", 16));
  l.putChange(state("i-e", "c2", 1, T("2024-04-10T01:00:00"), "paused", "enterprise", 16));
  l.settle(T("2024-05-01T00:00:00"));
  // base 29900 * 1h / 720h = 41.5277..., cpu 4000 -> 4041.5277 -> 4042
  assert.equal(l.readBill("i-e", "2024-04"), 4042);
  l.close();
});

test("cpu at or below baseline adds nothing", () => {
  const l = new BillingLedger();
  // enterprise baseline 8, cpu 8 -> no extra. Full Feb 2024 running.
  l.putChange(running("i-b8", "c1", 1, T("2024-02-01T00:00:00"), "enterprise", 8));
  l.settle(T("2024-03-01T00:00:00"));
  assert.equal(l.readBill("i-b8", "2024-02"), 29900);
  l.close();
});

test("highest revision wins; older revisions ignored; same-revision replay is a no-op", () => {
  const l = new BillingLedger();
  l.putChange(running("i-r", "c1", 1, T("2024-02-01T00:00:00")));
  l.putChange(state("i-r", "c2", 1, T("2024-02-15T00:00:00"), "paused"));
  // Newer revision of c1 moves its effective time to Feb 5.
  l.putChange(running("i-r", "c1", 3, T("2024-02-05T00:00:00")));
  // Late older revision with different content must be ignored.
  l.putChange(state("i-r", "c1", 2, T("2024-02-01T00:00:00"), "terminated"));
  // Same-version replay (identical content) must be a no-op.
  l.putChange(running("i-r", "c1", 3, T("2024-02-05T00:00:00")));
  l.settle(T("2024-03-01T00:00:00"));
  // running Feb 5 -> Feb 15 = 10 of 29 days: 2900 * 10/29 = 1000 exactly
  assert.equal(l.readBill("i-r", "2024-02"), 1000);
  const rows = l.ledgerRowCount();
  l.settle(T("2024-03-01T00:00:00"));
  assert.equal(l.ledgerRowCount(), rows);
  l.close();
});

test("revoke then restore with a newer revision", () => {
  const l = new BillingLedger();
  const until = T("2024-03-01T00:00:00");
  l.putChange(running("i-v", "c1", 1, T("2024-02-01T00:00:00")));
  l.settle(until);
  assert.equal(l.readBill("i-v", "2024-02"), 2900);

  l.putChange({ instanceId: "i-v", changeId: "c1", revision: 2, at: 0 });
  l.settle(until);
  assert.equal(l.readBill("i-v", "2024-02"), 0);

  l.putChange(running("i-v", "c1", 3, T("2024-02-01T00:00:00")));
  l.settle(until);
  assert.equal(l.readBill("i-v", "2024-02"), 2900);
  l.close();
});

test("settle with a decreasing cutoff is rejected", () => {
  const l = new BillingLedger();
  l.settle(T("2024-03-01T00:00:00"));
  assert.throws(() => l.settle(T("2024-02-01T00:00:00")), RangeError);
  l.close();
});

test("readBill for unknown instance or month is zero", () => {
  const l = new BillingLedger();
  l.settle(T("2024-03-01T00:00:00"));
  assert.equal(l.readBill("nope", "2024-02"), 0);
  l.close();
});
