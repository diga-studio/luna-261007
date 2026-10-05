import { DatabaseSync } from 'node:sqlite';
import type { AttemptStatus, EndpointState, MonotonicMs } from './types.js';

export interface PlanRow {
  planId: string;
  patchId: string;
  inflightCap: number;
  status: 'active' | 'done';
}

export interface EndpointRow {
  planId: string;
  endpointId: string;
  seq: number;
  state: EndpointState;
  attemptCount: number;
  currentAttemptId: string | null;
  cooldownUntil: MonotonicMs | null;
}

export interface AttemptRow {
  attemptId: string;
  planId: string;
  endpointId: string;
  attemptNo: number;
  status: AttemptStatus;
  lastClaimedAt: MonotonicMs;
  terminalAt: MonotonicMs | null;
}

/** SQLite 持久化层：只负责 plans/endpoints/attempts 三张表的读写，不含业务规则。 */
export class Store {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS plans (
        plan_id TEXT PRIMARY KEY,
        patch_id TEXT NOT NULL,
        inflight_cap INTEGER NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS endpoints (
        plan_id TEXT NOT NULL,
        endpoint_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        state TEXT NOT NULL,
        attempt_count INTEGER NOT NULL,
        current_attempt_id TEXT,
        cooldown_until INTEGER,
        PRIMARY KEY (plan_id, endpoint_id)
      );
      CREATE TABLE IF NOT EXISTS attempts (
        attempt_id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        endpoint_id TEXT NOT NULL,
        attempt_no INTEGER NOT NULL,
        status TEXT NOT NULL,
        last_claimed_at INTEGER NOT NULL,
        terminal_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_attempts_plan_status
        ON attempts (plan_id, status);
    `);
  }

  close(): void {
    this.db.close();
  }

  createPlan(planId: string, patchId: string, inflightCap: number, endpointIds: string[]): void {
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare('INSERT INTO plans (plan_id, patch_id, inflight_cap, status) VALUES (?, ?, ?, ?)')
        .run(planId, patchId, inflightCap, 'active');
      const insertEndpoint = this.db.prepare(
        `INSERT INTO endpoints
           (plan_id, endpoint_id, seq, state, attempt_count, current_attempt_id, cooldown_until)
         VALUES (?, ?, ?, 'pending', 0, NULL, NULL)`,
      );
      endpointIds.forEach((endpointId, seq) => {
        insertEndpoint.run(planId, endpointId, seq);
      });
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getActivePlan(): PlanRow | null {
    const row = this.db
      .prepare(`SELECT plan_id, patch_id, inflight_cap, status FROM plans WHERE status = 'active'`)
      .get() as Record<string, unknown> | undefined;
    return row ? mapPlan(row) : null;
  }

  getPlan(planId: string): PlanRow | null {
    const row = this.db
      .prepare('SELECT plan_id, patch_id, inflight_cap, status FROM plans WHERE plan_id = ?')
      .get(planId) as Record<string, unknown> | undefined;
    return row ? mapPlan(row) : null;
  }

  getLatestPlan(): PlanRow | null {
    const row = this.db
      .prepare('SELECT plan_id, patch_id, inflight_cap, status FROM plans ORDER BY rowid DESC LIMIT 1')
      .get() as Record<string, unknown> | undefined;
    return row ? mapPlan(row) : null;
  }

  markPlanDone(planId: string): void {
    this.db.prepare(`UPDATE plans SET status = 'done' WHERE plan_id = ?`).run(planId);
  }

  listEndpoints(planId: string): EndpointRow[] {
    const rows = this.db
      .prepare(
        `SELECT plan_id, endpoint_id, seq, state, attempt_count, current_attempt_id, cooldown_until
         FROM endpoints WHERE plan_id = ? ORDER BY seq`,
      )
      .all(planId) as unknown as Record<string, unknown>[];
    return rows.map(mapEndpoint);
  }

  getEndpoint(planId: string, endpointId: string): EndpointRow | null {
    const row = this.db
      .prepare(
        `SELECT plan_id, endpoint_id, seq, state, attempt_count, current_attempt_id, cooldown_until
         FROM endpoints WHERE plan_id = ? AND endpoint_id = ?`,
      )
      .get(planId, endpointId) as Record<string, unknown> | undefined;
    return row ? mapEndpoint(row) : null;
  }

  updateEndpointState(
    planId: string,
    endpointId: string,
    state: EndpointState,
    fields: { attemptCount?: number; currentAttemptId?: string | null; cooldownUntil?: MonotonicMs | null } = {},
  ): void {
    const current = this.getEndpoint(planId, endpointId);
    if (!current) throw new Error(`endpoint not found: ${endpointId}`);
    const attemptCount = fields.attemptCount ?? current.attemptCount;
    const currentAttemptId =
      fields.currentAttemptId === undefined ? current.currentAttemptId : fields.currentAttemptId;
    const cooldownUntil =
      fields.cooldownUntil === undefined ? current.cooldownUntil : fields.cooldownUntil;
    this.db
      .prepare(
        `UPDATE endpoints
         SET state = ?, attempt_count = ?, current_attempt_id = ?, cooldown_until = ?
         WHERE plan_id = ? AND endpoint_id = ?`,
      )
      .run(state, attemptCount, currentAttemptId, cooldownUntil, planId, endpointId);
  }

  insertAttempt(attempt: AttemptRow): void {
    this.db
      .prepare(
        `INSERT INTO attempts
           (attempt_id, plan_id, endpoint_id, attempt_no, status, last_claimed_at, terminal_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        attempt.attemptId,
        attempt.planId,
        attempt.endpointId,
        attempt.attemptNo,
        attempt.status,
        attempt.lastClaimedAt,
        attempt.terminalAt,
      );
  }

  getAttempt(attemptId: string): AttemptRow | null {
    const row = this.db
      .prepare(
        `SELECT attempt_id, plan_id, endpoint_id, attempt_no, status, last_claimed_at, terminal_at
         FROM attempts WHERE attempt_id = ?`,
      )
      .get(attemptId) as Record<string, unknown> | undefined;
    return row ? mapAttempt(row) : null;
  }

  updateAttemptStatus(attemptId: string, status: AttemptStatus, terminalAt: MonotonicMs | null): void {
    this.db
      .prepare('UPDATE attempts SET status = ?, terminal_at = ? WHERE attempt_id = ?')
      .run(status, terminalAt, attemptId);
  }

  touchAttemptClaim(attemptId: string, now: MonotonicMs): void {
    this.db
      .prepare('UPDATE attempts SET last_claimed_at = ? WHERE attempt_id = ?')
      .run(now, attemptId);
  }

  countInflight(planId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM attempts
         WHERE plan_id = ? AND status IN ('claimed', 'downloading', 'installing')`,
      )
      .get(planId) as { n: number };
    return Number(row.n);
  }

  listRedispatchable(planId: string, claimedBefore: MonotonicMs): AttemptRow[] {
    const rows = this.db
      .prepare(
        `SELECT attempt_id, plan_id, endpoint_id, attempt_no, status, last_claimed_at, terminal_at
         FROM attempts
         WHERE plan_id = ?
           AND status IN ('claimed', 'downloading', 'installing')
           AND last_claimed_at <= ?
         ORDER BY last_claimed_at`,
      )
      .all(planId, claimedBefore) as unknown as Record<string, unknown>[];
    return rows.map(mapAttempt);
  }
}

function mapPlan(row: Record<string, unknown>): PlanRow {
  return {
    planId: String(row.plan_id),
    patchId: String(row.patch_id),
    inflightCap: Number(row.inflight_cap),
    status: row.status as PlanRow['status'],
  };
}

function mapEndpoint(row: Record<string, unknown>): EndpointRow {
  return {
    planId: String(row.plan_id),
    endpointId: String(row.endpoint_id),
    seq: Number(row.seq),
    state: row.state as EndpointRow['state'],
    attemptCount: Number(row.attempt_count),
    currentAttemptId: row.current_attempt_id === null ? null : String(row.current_attempt_id),
    cooldownUntil: row.cooldown_until === null ? null : Number(row.cooldown_until),
  };
}

function mapAttempt(row: Record<string, unknown>): AttemptRow {
  return {
    attemptId: String(row.attempt_id),
    planId: String(row.plan_id),
    endpointId: String(row.endpoint_id),
    attemptNo: Number(row.attempt_no),
    status: row.status as AttemptRow['status'],
    lastClaimedAt: Number(row.last_claimed_at),
    terminalAt: row.terminal_at === null ? null : Number(row.terminal_at),
  };
}
