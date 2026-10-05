import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { BillingStore } from '../src/index.js';
import type { Change } from '../src/index.js';

function up(
  instanceId: string,
  changeId: string,
  revision: number,
  at: number,
  state: 'running' | 'provisioning' | 'paused' | 'terminated',
  tier: 'starter' | 'growth' | 'enterprise',
  cpu: number,
): Change {
  return { instanceId, changeId, revision, at, snapshot: { state, tier, cpu } };
}

function revoke(instanceId: string, changeId: string, revision: number, at: number): Change {
  return { instanceId, changeId, revision, at };
}

interface LedgerRow {
  seq: number;
  instance_id: string;
  month: string;
  delta_cents: number;
  settled_until: number;
}

function ledgerRows(dbPath: string): LedgerRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare('SELECT seq, instance_id, month, delta_cents, settled_until FROM ledger ORDER BY seq')
      .all() as LedgerRow[];
  } finally {
    db.close();
  }
}

function withStore(fn: (store: BillingStore, dbPath: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'storeforge-'));
  const dbPath = path.join(dir, 'billing.db');
  const store = new BillingStore({ path: dbPath });
  try {
    fn(store, dbPath);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('leap-year February: cross-month change prorated by actual month length', () => {
  withStore((store) => {
    // 2024 is a leap year: February has 29 days.
    const at = Date.UTC(2024, 1, 28, 12); // Feb 28 12:00 UTC
    store.putChange(up('i1', 'c1', 1, at, 'running', 'starter', 2));
    store.settle(Date.UTC(2024, 2, 2)); // Mar 2 00:00 UTC

    // Feb segment: Feb 28 12:00 -> Mar 1 00:00 = 36h.
    // base = 2900 * 36h / (29*24h) = 150 exactly; extra cpu = 1 * 500 * 36 = 18000.
    assert.equal(store.readBill('i1', '2024-02'), 18150);
    // Mar segment: 24h. base = 2900/31 = 93.548...; extra = 12000.
    // Rounded once on the monthly total: 12093.548... -> 12094.
    assert.equal(store.readBill('i1', '2024-03'), 12094);
  });
});

test('non-leap February prorates by 28 days', () => {
  withStore((store) => {
    store.putChange(up('i2', 'c1', 1, Date.UTC(2023, 1, 25, 12), 'running', 'starter', 2));
    store.settle(Date.UTC(2023, 1, 27)); // 36h segment inside Feb 2023 (28 days)
    // base = 2900 * 36 / (28*24) = 155.357...; extra = 18000 -> 18155.357 -> 18155.
    assert.equal(store.readBill('i2', '2023-02'), 18155);
  });
});

test('rounding happens once on the monthly total, half cent rounds up', () => {
  withStore((store) => {
    // Three separate 1-hour running segments in Feb 2024 (leap, 29 days).
    // Each hour is 2900/(29*24) = 4.1666... cents; per-segment rounding would
    // give 4+4+4 = 12, but the exact total is 12.5 which rounds half-up to 13.
    const h = 3_600_000;
    const t0 = Date.UTC(2024, 1, 10);
    store.putChange(up('i3', 'c1', 1, t0 + 0 * h, 'running', 'starter', 1));
    store.putChange(up('i3', 'c2', 1, t0 + 1 * h, 'paused', 'starter', 1));
    store.putChange(up('i3', 'c3', 1, t0 + 2 * h, 'running', 'starter', 1));
    store.putChange(up('i3', 'c4', 1, t0 + 3 * h, 'paused', 'starter', 1));
    store.putChange(up('i3', 'c5', 1, t0 + 4 * h, 'running', 'starter', 1));
    store.putChange(up('i3', 'c6', 1, t0 + 5 * h, 'terminated', 'starter', 1));
    store.settle(Date.UTC(2024, 2, 1));
    assert.equal(store.readBill('i3', '2024-02'), 13);
  });
});

test('retroactive move to another month then revoke appends signed deltas', () => {
  withStore((store, dbPath) => {
    const feb1 = Date.UTC(2024, 1, 1);
    const mar1 = Date.UTC(2024, 2, 1);

    // 1) running growth cpu=6 from Jan 10; settle to Feb 1.
    store.putChange(up('i1', 'c1', 1, Date.UTC(2024, 0, 10), 'running', 'growth', 6));
    store.settle(feb1);
    // Jan: 22 days. base = 9900*22/31 = 7025.806...; extra = 2*500*528 = 528000.
    assert.equal(store.readBill('i1', '2024-01'), 535026);
    assert.equal(ledgerRows(dbPath).length, 1);

    // 2) rev2 moves the change to Feb 10; settle to Mar 1.
    store.putChange(up('i1', 'c1', 2, Date.UTC(2024, 1, 10), 'running', 'growth', 6));
    store.settle(mar1);
    assert.equal(store.readBill('i1', '2024-01'), 0); // 535026 - 535026
    // Feb: 20 days of 29. base = 9900*20/29 = 6827.586...; extra = 2*500*480 = 480000.
    assert.equal(store.readBill('i1', '2024-02'), 486828);

    let rows = ledgerRows(dbPath);
    assert.equal(rows.length, 3);
    // Original row untouched; corrections are appended, not modified.
    assert.deepEqual(
      rows.map((r) => [r.month, r.delta_cents, r.settled_until]),
      [
        ['2024-01', 535026, feb1],
        ['2024-01', -535026, mar1],
        ['2024-02', 486828, mar1],
      ],
    );

    // 3) rev3 revokes the change entirely; re-settle the same cutoff.
    store.putChange(revoke('i1', 'c1', 3, Date.UTC(2024, 1, 10)));
    store.settle(mar1);
    assert.equal(store.readBill('i1', '2024-01'), 0);
    assert.equal(store.readBill('i1', '2024-02'), 0);
    rows = ledgerRows(dbPath);
    assert.equal(rows.length, 4);
    assert.equal(rows[3].month, '2024-02');
    assert.equal(rows[3].delta_cents, -486828);

    // 4) identical repeat settle appends nothing.
    store.settle(mar1);
    assert.equal(ledgerRows(dbPath).length, 4);
  });
});

test('highest revision wins; older revisions and same-revision replays are ignored', () => {
  withStore((store) => {
    const mar1 = Date.UTC(2024, 2, 1);
    store.putChange(up('i1', 'c1', 2, Date.UTC(2024, 1, 5), 'running', 'starter', 1));
    // Older revision with a different timestamp must be ignored.
    store.putChange(up('i1', 'c1', 1, Date.UTC(2024, 0, 10), 'running', 'starter', 1));
    // Same-revision replay is a no-op.
    store.putChange(up('i1', 'c1', 2, Date.UTC(2024, 1, 5), 'running', 'starter', 1));
    store.settle(mar1);
    assert.equal(store.readBill('i1', '2024-01'), 0);
    // Feb 5 -> Mar 1 = 25 days of 29: 2900*25/29 = 2500 exactly.
    assert.equal(store.readBill('i1', '2024-02'), 2500);
  });
});

test('revoke then restore with a newer revision', () => {
  withStore((store) => {
    const feb1 = Date.UTC(2024, 1, 1);
    store.putChange(up('i1', 'c1', 1, Date.UTC(2024, 0, 5), 'running', 'enterprise', 8));
    store.putChange(revoke('i1', 'c1', 2, Date.UTC(2024, 0, 5)));
    store.putChange(up('i1', 'c1', 3, Date.UTC(2024, 0, 6), 'running', 'enterprise', 8));
    store.settle(feb1);
    // Jan 6 -> Feb 1 = 26 days of 31, cpu 8 == baseline so no extra.
    // 29900*26/31 = 25077.419... -> 25077.
    assert.equal(store.readBill('i1', '2024-01'), 25077);
  });
});

test('settle rejects a decreasing cutoff', () => {
  withStore((store) => {
    store.settle(Date.UTC(2024, 2, 1));
    assert.throws(() => store.settle(Date.UTC(2024, 1, 1)), /before previous cutoff/);
  });
});

test('readBill returns zero for unknown instance or month', () => {
  withStore((store) => {
    assert.equal(store.readBill('nope', '2024-01'), 0);
    store.putChange(up('i1', 'c1', 1, Date.UTC(2024, 0, 1), 'running', 'starter', 1));
    store.settle(Date.UTC(2024, 0, 2));
    assert.equal(store.readBill('i1', '2024-02'), 0);
  });
});

test('only running segments are billed', () => {
  withStore((store) => {
    const t0 = Date.UTC(2024, 0, 10);
    const h = 3_600_000;
    store.putChange(up('i1', 'c1', 1, t0, 'provisioning', 'starter', 4));
    store.putChange(up('i1', 'c2', 1, t0 + 2 * h, 'running', 'starter', 4));
    store.putChange(up('i1', 'c3', 1, t0 + 5 * h, 'paused', 'starter', 4));
    store.settle(Date.UTC(2024, 1, 1));
    // 3 running hours in Jan (31 days), cpu 4 -> 3 extra units.
    // base = 2900*3/(31*24) = 11.693...; extra = 3*500*3 = 4500 -> 4511.693 -> 4512.
    assert.equal(store.readBill('i1', '2024-01'), 4512);
  });
});
