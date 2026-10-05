import { Store } from "./store";
import { computeCharges } from "./billing";
import { Change } from "./types";

/**
 * StoreForge usage billing ledger.
 *
 * - putChange: records a revision/revocation of a resource change. Never
 *   writes ledger rows by itself.
 * - settle(until): recomputes every instance's per-month charges over
 *   [0, until) from the current highest-revision timeline and appends
 *   signed delta rows so each month's ledger sum equals the recomputed
 *   amount. Existing rows are never modified or deleted.
 * - readBill(instanceId, month): net posted cents for a UTC month.
 */
export class BillingLedger {
  private store: Store;

  constructor(dbPath: string = ":memory:") {
    this.store = new Store(dbPath);
    this.store.init();
  }

  close(): void {
    this.store.close();
  }

  putChange(change: Change): void {
    this.store.upsertChange(change);
  }

  settle(until: number): void {
    if (!Number.isInteger(until)) {
      throw new TypeError("settle(until): until must be an integer millisecond timestamp");
    }
    const watermark = this.store.getWatermark();
    if (watermark !== null && until < watermark) {
      throw new RangeError(
        `settle(until): until (${until}) is before the current watermark (${watermark})`
      );
    }

    for (const instanceId of this.store.getAllInstanceIds()) {
      const changes = this.store.getEffectiveChanges(instanceId);
      const targets = new Map<string, number>();
      for (const { month, amountCents } of computeCharges(changes, until)) {
        targets.set(month, amountCents);
      }
      // Months with existing rows must be reconciled too (a change may have
      // moved away, driving the target to zero).
      const months = new Set<string>([
        ...targets.keys(),
        ...this.store.getLedgerMonths(instanceId),
      ]);
      for (const month of [...months].sort()) {
        const target = targets.get(month) ?? 0;
        const posted = this.store.getLedgerSum(instanceId, month);
        const delta = target - posted;
        if (delta !== 0) {
          this.store.appendLedgerRow(instanceId, month, delta);
        }
      }
    }

    this.store.setWatermark(until);
  }

  readBill(instanceId: string, month: string): number {
    return this.store.getLedgerSum(instanceId, month);
  }

  /** Append-only ledger rows for an instance/month, oldest first. */
  ledgerRows(instanceId: string, month: string) {
    return this.store.getLedgerRows(instanceId, month);
  }

  /** Total number of ledger rows across all instances (test/diagnostic). */
  ledgerRowCount(): number {
    return this.store.getLedgerRowCount();
  }
}
