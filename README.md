# StoreForge Billing

Usage billing library for StoreForge: resource changes in, monthly ledger out.
TypeScript + SQLite (`node:sqlite`, no native dependencies).

## API

```ts
import { BillingLedger } from "storeforge-billing";

const ledger = new BillingLedger("billing.db"); // or ":memory:"

ledger.putChange({
  instanceId: "i-1",
  changeId: "c1",
  revision: 1,
  at: Date.UTC(2024, 1, 10),          // UTC ms; snapshot effective from here
  snapshot: { state: "running", tier: "growth", cpu: 6 },
});
ledger.putChange({ instanceId: "i-1", changeId: "c1", revision: 2, at: 0 }); // revoke

ledger.settle(Date.UTC(2024, 2, 1));  // settle up to a UTC ms cutoff (non-decreasing)
ledger.readBill("i-1", "2024-02");    // net posted cents for that UTC month
```

- `putChange(change)` records a revision (full `state`/`tier`/`cpu` snapshot) or a
  revocation (no `snapshot`). Highest revision per `changeId` wins; older revisions
  are ignored and same-version replays are no-ops. Never writes ledger rows.
- `settle(until)` recomputes every instance's per-month charges over `[0, until)`
  from the current highest-revision timeline and appends signed delta rows so each
  month's ledger sum equals the recomputed amount. Rows are append-only; zero
  deltas are skipped, so re-settling unchanged inputs adds nothing.
- `readBill(instanceId, month)` returns the net posted cents for a UTC month
  (`"YYYY-MM"`).

## Pricing

- Tiers: starter 2900c/mo (1 CPU baseline), growth 9900c/mo (4), enterprise 29900c/mo (8).
- Only `running` is billed; `provisioning`, `paused`, `terminated` are free.
- Base fee is prorated by the actual milliseconds of each UTC month; CPU beyond the
  tier baseline costs 500c per unit-hour. Each instance-month accumulates base and
  extra-CPU fees exactly (rational arithmetic), then rounds half-up to whole cents.

## Develop

```sh
npm install
npm test   # builds with tsc, runs node:test suites in test/
```
