import Database from 'better-sqlite3';
import { computeMonthCents, monthKeyOf, monthStartMs, nextMonthKey } from './billing.js';
import type { EffectiveChange } from './billing.js';
import type { Change, InstanceState, Tier } from './types.js';

export interface BillingStoreOptions {
  /** SQLite file path, or ":memory:" (default). */
  path?: string;
}

interface ChangeRow {
  instance_id: string;
  change_id: string;
  revision: number;
  at: number;
  state: InstanceState | null;
  tier: Tier | null;
  cpu: number | null;
}

export class BillingStore {
  private readonly db: Database.Database;

  constructor(options?: BillingStoreOptions) {
    this.db = new Database(options?.path ?? ':memory:');
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS changes (
        change_id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        at INTEGER NOT NULL,
        state TEXT,
        tier TEXT,
        cpu INTEGER
      );
      CREATE TABLE IF NOT EXISTS ledger (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_id TEXT NOT NULL,
        month TEXT NOT NULL,
        delta_cents INTEGER NOT NULL,
        settled_until INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ledger_instance_month
        ON ledger (instance_id, month);
      CREATE TABLE IF NOT EXISTS meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_until INTEGER
      );
    `);
  }

  /** Submit a revision or revocation of a resource snapshot. Never writes ledger rows. */
  putChange(change: Change): void {
    const existing = this.db
      .prepare('SELECT revision FROM changes WHERE change_id = ?')
      .get(change.changeId) as { revision: number } | undefined;
    // Older revisions and same-revision replays are no-ops.
    if (existing !== undefined && existing.revision >= change.revision) return;

    this.db
      .prepare(
        `INSERT OR REPLACE INTO changes
           (change_id, instance_id, revision, at, state, tier, cpu)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        change.changeId,
        change.instanceId,
        change.revision,
        change.at,
        change.snapshot?.state ?? null,
        change.snapshot?.tier ?? null,
        change.snapshot?.cpu ?? null,
      );
  }

  /**
   * Settle billing up to `until` (UTC ms). Cutoffs are non-decreasing;
   * re-settling the same cutoff still applies retroactive corrections by
   * appending signed delta rows. Months are recomputed from the current
   * highest-revision timelines; existing ledger rows are never modified.
   */
  settle(until: number): void {
    if (!Number.isFinite(until)) throw new Error('settle: until must be a finite number');
    const last = this.lastUntil();
    if (last !== null && until < last) {
      throw new Error(`settle: cutoff ${until} is before previous cutoff ${last}`);
    }

    const run = this.db.transaction(() => {
      const instanceIds = this.db
        .prepare('SELECT DISTINCT instance_id FROM changes')
        .all() as Array<{ instance_id: string }>;
      for (const { instance_id: instanceId } of instanceIds) {
        this.settleInstance(instanceId, until);
      }
      this.db
        .prepare('INSERT OR REPLACE INTO meta (id, last_until) VALUES (1, ?)')
        .run(until);
    });
    run();
  }

  /** Net billed integer cents for an instance in a UTC month ("YYYY-MM"). */
  readBill(instanceId: string, month: string): number {
    const row = this.db
      .prepare(
        'SELECT COALESCE(SUM(delta_cents), 0) AS total FROM ledger WHERE instance_id = ? AND month = ?',
      )
      .get(instanceId, month) as { total: number };
    return row.total;
  }

  close(): void {
    this.db.close();
  }

  private lastUntil(): number | null {
    const row = this.db.prepare('SELECT last_until FROM meta WHERE id = 1').get() as
      | { last_until: number }
      | undefined;
    return row?.last_until ?? null;
  }

  private settleInstance(instanceId: string, until: number): void {
    const rows = this.db
      .prepare(
        `SELECT at, state, tier, cpu FROM changes
         WHERE instance_id = ? AND state IS NOT NULL
         ORDER BY at ASC`,
      )
      .all(instanceId) as ChangeRow[];

    const timeline: EffectiveChange[] = rows.map((r) => ({
      at: r.at,
      snapshot: { state: r.state as InstanceState, tier: r.tier as Tier, cpu: r.cpu as number },
    }));

    const ledgerMonths = this.db
      .prepare('SELECT DISTINCT month FROM ledger WHERE instance_id = ?')
      .all(instanceId) as Array<{ month: string }>;

    if (timeline.length === 0 && ledgerMonths.length === 0) return;

    // Cover every month that could be owed under the current timeline plus
    // every month already in the ledger (so corrections can zero them out).
    let lo: string | null = timeline.length > 0 ? monthKeyOf(timeline[0].at) : null;
    let hi: string = monthKeyOf(until);
    for (const { month } of ledgerMonths) {
      if (lo === null || month < lo) lo = month;
      if (month > hi) hi = month;
    }
    if (lo === null) return;

    const billedStmt = this.db.prepare(
      'SELECT COALESCE(SUM(delta_cents), 0) AS total FROM ledger WHERE instance_id = ? AND month = ?',
    );
    const insertStmt = this.db.prepare(
      'INSERT INTO ledger (instance_id, month, delta_cents, settled_until) VALUES (?, ?, ?, ?)',
    );

    for (let month = lo; month <= hi; month = nextMonthKey(month)) {
      const owed = computeMonthCents(timeline, monthStartMs(month), until);
      const billed = (billedStmt.get(instanceId, month) as { total: number }).total;
      const delta = owed - billed;
      if (delta !== 0) {
        insertStmt.run(instanceId, month, delta, until);
      }
    }
  }
}
