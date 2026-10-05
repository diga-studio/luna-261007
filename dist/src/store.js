import { DatabaseSync } from "node:sqlite";
/** SQLite 持久化层。 */
export class Store {
    db;
    constructor(path) {
        this.db = new DatabaseSync(path);
        this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY,
        patch_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS targets (
        plan_id TEXT NOT NULL,
        endpoint_id TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        cooldown_until INTEGER,
        finished INTEGER NOT NULL,
        last_terminal TEXT,
        PRIMARY KEY (plan_id, endpoint_id)
      );
      CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        endpoint_id TEXT NOT NULL,
        attempt_no INTEGER NOT NULL,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_claim_at INTEGER NOT NULL,
        finalized_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_attempts_endpoint
        ON attempts (plan_id, endpoint_id, state);
    `);
    }
    close() {
        this.db.close();
    }
    getActivePlan() {
        return this.db
            .prepare(`SELECT * FROM plans WHERE status = 'active'`)
            .get();
    }
    getLatestPlan() {
        return this.db
            .prepare(`SELECT * FROM plans ORDER BY created_at DESC LIMIT 1`)
            .get();
    }
    insertPlan(id, patchId, now) {
        this.db
            .prepare(`INSERT INTO plans (id, patch_id, status, created_at)
         VALUES (?, ?, 'active', ?)`)
            .run(id, patchId, now);
    }
    setPlanStatus(planId, status) {
        this.db
            .prepare(`UPDATE plans SET status = ? WHERE id = ?`)
            .run(status, planId);
    }
    insertTarget(planId, endpointId) {
        this.db
            .prepare(`INSERT INTO targets (plan_id, endpoint_id, attempts, cooldown_until, finished, last_terminal)
         VALUES (?, ?, 0, NULL, 0, NULL)`)
            .run(planId, endpointId);
    }
    getTargets(planId) {
        return this.db
            .prepare(`SELECT * FROM targets WHERE plan_id = ? ORDER BY endpoint_id`)
            .all(planId);
    }
    getTarget(planId, endpointId) {
        return this.db
            .prepare(`SELECT * FROM targets WHERE plan_id = ? AND endpoint_id = ?`)
            .get(planId, endpointId);
    }
    updateTarget(target) {
        this.db
            .prepare(`UPDATE targets
         SET attempts = ?, cooldown_until = ?, finished = ?, last_terminal = ?
         WHERE plan_id = ? AND endpoint_id = ?`)
            .run(target.attempts, target.cooldown_until, target.finished, target.last_terminal, target.plan_id, target.endpoint_id);
    }
    insertAttempt(attempt) {
        this.db
            .prepare(`INSERT INTO attempts
           (id, plan_id, endpoint_id, attempt_no, state, created_at, last_claim_at, finalized_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(attempt.id, attempt.plan_id, attempt.endpoint_id, attempt.attempt_no, attempt.state, attempt.created_at, attempt.last_claim_at, attempt.finalized_at);
    }
    getAttempt(id) {
        return this.db.prepare(`SELECT * FROM attempts WHERE id = ?`).get(id);
    }
    updateAttemptState(id, state, finalizedAt) {
        this.db
            .prepare(`UPDATE attempts SET state = ?, finalized_at = ? WHERE id = ?`)
            .run(state, finalizedAt, id);
    }
    touchAttemptClaim(id, now) {
        this.db
            .prepare(`UPDATE attempts SET last_claim_at = ? WHERE id = ?`)
            .run(now, id);
    }
    /** 某计划下所有在途（非终态）尝试。 */
    getInFlightAttempts(planId) {
        return this.db
            .prepare(`SELECT * FROM attempts
         WHERE plan_id = ?
           AND state IN ('dispatched', 'downloading', 'installing')
         ORDER BY created_at`)
            .all(planId);
    }
    getAttemptsForEndpoint(planId, endpointId) {
        return this.db
            .prepare(`SELECT * FROM attempts
         WHERE plan_id = ? AND endpoint_id = ?
         ORDER BY attempt_no`)
            .all(planId, endpointId);
    }
    transaction(fn) {
        this.db.exec("BEGIN");
        try {
            const result = fn();
            this.db.exec("COMMIT");
            return result;
        }
        catch (err) {
            this.db.exec("ROLLBACK");
            throw err;
        }
    }
}
