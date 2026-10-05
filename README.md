# StoreForge Billing

Usage-billing library for StoreForge. It ingests resource snapshot revisions
(`putChange`), settles them into an append-only monthly ledger (`settle`), and
reports net billed cents per instance per UTC month (`readBill`). Persistence
is a single SQLite file (via `better-sqlite3`).

## Requirements

- Node.js 20+ and npm. No other services are needed.

## Setup & test

```sh
npm install
npm test
```

## API

```ts
import { BillingStore } from 'storeforge-billing';

const store = new BillingStore({ path: 'billing.db' }); // or ':memory:'

// Submit a revision of a resource snapshot (never writes ledger rows).
store.putChange({
  instanceId: 'i-1',
  changeId: 'c-1',
  revision: 1,
  at: Date.UTC(2024, 1, 28, 12), // UTC ms
  snapshot: { state: 'running', tier: 'starter', cpu: 2 },
});

// Revoke the change (no snapshot) with a higher revision.
store.putChange({ instanceId: 'i-1', changeId: 'c-1', revision: 2, at: Date.UTC(2024, 2, 1) });

// Settle up to a UTC-ms cutoff. Cutoffs are non-decreasing; re-settling the
// same cutoff still applies retroactive corrections as signed delta rows.
store.settle(Date.UTC(2024, 2, 2));

// Net billed integer cents for one UTC month.
store.readBill('i-1', '2024-02');
```

## Billing rules

- Tiers: starter 2900¢/mo (1 CPU baseline), growth 9900¢/mo (4),
  enterprise 29900¢/mo (8). `cpu` ranges 1–16.
- Only `running` segments are billed; `provisioning`, `paused` and
  `terminated` are free. A snapshot bills from its `at` until the next
  effective change; time before the first change is free. Intervals are
  left-closed, right-open.
- Base price is prorated by the actual millisecond length of the UTC month;
  CPU above the tier baseline costs 500¢ per unit-hour.
- Per instance and month, base and extra-CPU fees are accumulated exactly
  (rational arithmetic) and rounded once, half-up, to integer cents.
- The highest revision of a `changeId` decides; older revisions and
  same-revision replays are ignored. Revisions may move `at`, replace the
  snapshot, revoke, or restore.
- The ledger is append-only: retroactive corrections are appended as signed
  delta rows; zero deltas and no-op repeat settles add no rows.
