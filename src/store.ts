import { DatabaseSync } from "node:sqlite";
import { Change, LedgerRow, Snapshot, ResourceState, Tier } from "./types";

interface ChangeRow {
  change_id: string;
  instance_id: string;
  revision: number;
  at_ms: number | null;
  revoked: number;
  state: string | null;
  tier: string | null;
  cpu: number | null;
}

interface LedgerDbRow {
  id: number;
  instance_id: string;
  month: string;
  delta_cents: number;
}

export class Store {
  private db: DatabaseSync;

  constructor(path: string = ":memory:") {
    this.db = new DatabaseSync(path);
  }

  init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS changes (
        change_id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        at_ms INTEGER,
        revoked INTEGER NOT NULL,
        state TEXT,
        tier TEXT,
        cpu INTEGER
      );
      CREATE TABLE IF NOT EXISTS ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_id TEXT NOT NULL,
        month TEXT NOT NULL,
        delta_cents INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ledger_instance_month
        ON ledger (instance_id, month);
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  /** Applies the change if its revision is the highest seen; returns whether applied. */
  upsertChange(change: Change): boolean {
    const existing = this.db
      .prepare("SELECT revision FROM changes WHERE change_id = ?")
      .get(change.changeId) as { revision: number } | undefined;
    if (existing && existing.revision >= change.revision) {
      return false;
    }
    this.db
      .prepare(
        `INSERT OR REPLACE INTO changes
         (change_id, instance_id, revision, at_ms, revoked, state, tier, cpu)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        change.changeId,
        change.instanceId,
        change.revision,
        change.snapshot ? change.at : null,
        change.snapshot ? 0 : 1,
        change.snapshot?.state ?? null,
        change.snapshot?.tier ?? null,
        change.snapshot?.cpu ?? null
      );
    return true;
  }

  /** Current effective (highest-revision, non-revoked) changes, ordered by at. */
  getEffectiveChanges(instanceId: string): Change[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM changes
         WHERE instance_id = ? AND revoked = 0
         ORDER BY at_ms ASC, change_id ASC`
      )
      .all(instanceId) as unknown as ChangeRow[];
    return rows.map(rowToChange);
  }

  /** Instances that have any changes or any ledger rows. */
  getAllInstanceIds(): string[] {
    const rows = this.db
      .prepare(
        `SELECT instance_id FROM changes
         UNION
         SELECT instance_id FROM ledger
         ORDER BY instance_id`
      )
      .all() as unknown as { instance_id: string }[];
    return rows.map((r) => r.instance_id);
  }

  getWatermark(): number | null {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = 'watermark'")
      .get() as { value: string } | undefined;
    return row ? Number(row.value) : null;
  }

  setWatermark(until: number): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO meta (key, value) VALUES ('watermark', ?)`
      )
      .run(String(until));
  }

  appendLedgerRow(instanceId: string, month: string, deltaCents: number): void {
    this.db
      .prepare(
        `INSERT INTO ledger (instance_id, month, delta_cents) VALUES (?, ?, ?)`
      )
      .run(instanceId, month, deltaCents);
  }

  getLedgerRows(instanceId: string, month: string): LedgerRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, instance_id, month, delta_cents FROM ledger
         WHERE instance_id = ? AND month = ? ORDER BY id`
      )
      .all(instanceId, month) as unknown as LedgerDbRow[];
    return rows.map((r) => ({
      id: r.id,
      instanceId: r.instance_id,
      month: r.month,
      amountCents: r.delta_cents,
    }));
  }

  getLedgerSum(instanceId: string, month: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(delta_cents), 0) AS total FROM ledger
         WHERE instance_id = ? AND month = ?`
      )
      .get(instanceId, month) as { total: number };
    return row.total;
  }

  /** Distinct months that already have ledger rows for the instance. */
  getLedgerMonths(instanceId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT month FROM ledger WHERE instance_id = ? ORDER BY month`
      )
      .all(instanceId) as unknown as { month: string }[];
    return rows.map((r) => r.month);
  }

  /** Raw count of ledger rows (test/diagnostic helper). */
  getLedgerRowCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM ledger")
      .get() as { n: number };
    return row.n;
  }
}

function rowToChange(row: ChangeRow): Change {
  const snapshot: Snapshot = {
    state: row.state as ResourceState,
    tier: row.tier as Tier,
    cpu: row.cpu as number,
  };
  return {
    instanceId: row.instance_id,
    changeId: row.change_id,
    revision: row.revision,
    at: row.at_ms as number,
    snapshot,
  };
}
