import { test } from "node:test";
import assert from "node:assert/strict";
import { BillingLedger, Change } from "../src/index";

const T = (iso: string) => Date.parse(`${iso}Z`);

const jan10 = T("2024-01-10T00:00:00");
const feb10 = T("2024-02-10T00:00:00");
const until = T("2024-03-01T00:00:00");

function runningAt(at: number, revision: number): Change {
  return {
    instanceId: "i-1",
    changeId: "c1",
    revision,
    at,
    snapshot: { state: "running", tier: "starter", cpu: 1 },
  };
}

test("move a settled change to another month, then revoke: signed deltas, immutable history, idempotent re-settle", () => {
  const l = new BillingLedger();

  // rev1: running since Jan 10. Jan 2024 has 31 days.
  l.putChange(runningAt(jan10, 1));
  l.settle(until);
  // Jan: 22 of 31 days -> 2900 * 22/31 = 2058.06... -> 2058
  assert.equal(l.readBill("i-1", "2024-01"), 2058);
  // Feb: full leap month -> 2900
  assert.equal(l.readBill("i-1", "2024-02"), 2900);
  assert.equal(l.ledgerRowCount(), 2);

  // rev2: the running change actually started Feb 10, not Jan 10.
  l.putChange(runningAt(feb10, 2));
  l.settle(until);
  // January is fully refunded, February corrected down.
  assert.equal(l.readBill("i-1", "2024-01"), 0);
  // Feb 10 -> Mar 1 = 20 of 29 days -> 2900 * 20/29 = 2000 exactly
  assert.equal(l.readBill("i-1", "2024-02"), 2000);
  assert.equal(l.ledgerRowCount(), 4);

  // History is append-only: the original rows are untouched.
  assert.deepEqual(
    l.ledgerRows("i-1", "2024-01").map((r) => r.amountCents),
    [2058, -2058]
  );
  assert.deepEqual(
    l.ledgerRows("i-1", "2024-02").map((r) => r.amountCents),
    [2900, -900]
  );

  // rev3: revoke the change entirely. Same cutoff, retro correction.
  l.putChange({ instanceId: "i-1", changeId: "c1", revision: 3, at: 0 });
  l.settle(until);
  assert.equal(l.readBill("i-1", "2024-01"), 0);
  assert.equal(l.readBill("i-1", "2024-02"), 0);
  // January needed no further delta (already net zero); February got -2000.
  assert.equal(l.ledgerRowCount(), 5);
  assert.deepEqual(
    l.ledgerRows("i-1", "2024-02").map((r) => r.amountCents),
    [2900, -900, -2000]
  );

  // Re-settling with unchanged inputs and cutoff appends nothing.
  l.settle(until);
  assert.equal(l.ledgerRowCount(), 5);
  // Replaying the same revision changes nothing either.
  l.putChange({ instanceId: "i-1", changeId: "c1", revision: 3, at: 0 });
  l.settle(until);
  assert.equal(l.ledgerRowCount(), 5);

  l.close();
});

test("late revision can increase an already-settled month", () => {
  const l = new BillingLedger();
  // Starts paused; settled. Then a late revision says it was running all along.
  l.putChange({
    instanceId: "i-2",
    changeId: "c1",
    revision: 1,
    at: T("2024-02-01T00:00:00"),
    snapshot: { state: "paused", tier: "starter", cpu: 1 },
  });
  l.settle(until);
  assert.equal(l.readBill("i-2", "2024-02"), 0);
  assert.equal(l.ledgerRowCount(), 0);

  l.putChange({
    instanceId: "i-2",
    changeId: "c1",
    revision: 2,
    at: T("2024-02-01T00:00:00"),
    snapshot: { state: "running", tier: "starter", cpu: 1 },
  });
  l.settle(until);
  assert.equal(l.readBill("i-2", "2024-02"), 2900);
  assert.deepEqual(
    l.ledgerRows("i-2", "2024-02").map((r) => r.amountCents),
    [2900]
  );
  l.close();
});
