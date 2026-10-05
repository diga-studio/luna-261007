import { DatabaseSync } from 'node:sqlite';
import { checkAndAdvanceClock } from './clock.js';
import type {
  Decision,
  DecisionInput,
  GrantInput,
  GrantState,
  ReviewCycleInfo,
} from './types.js';

export const REVIEW_PERIOD_MS = 14 * 24 * 60 * 60 * 1000;

interface GrantRow {
  id: number;
  user: string;
  database: string;
  role: string;
  revoked: number;
}

interface EntryRow {
  id: number;
  cycle_id: number;
  grant_id: number;
  status: 'pending' | 'confirmed' | 'revoked';
}

const DECISION_TO_STATUS: Record<Decision, 'confirmed' | 'revoked'> = {
  confirm: 'confirmed',
  revoke: 'revoked',
};

export class AccessReviewService {
  constructor(private readonly db: DatabaseSync) {}

  grantAccess(input: GrantInput, now: number): number {
    checkAndAdvanceClock(this.db, now);
    try {
      const result = this.db
        .prepare(
          'INSERT INTO grants (user, database, role, created_at) VALUES (?, ?, ?, ?)',
        )
        .run(input.user, input.database, input.role, now);
      return Number(result.lastInsertRowid);
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.includes('UNIQUE constraint failed: grants.user')
      ) {
        throw new Error(
          `an unrevoked grant already exists for user=${input.user} database=${input.database} role=${input.role}`,
        );
      }
      throw err;
    }
  }

  openReviewCycle(database: string, now: number): ReviewCycleInfo {
    checkAndAdvanceClock(this.db, now);
    const deadline = now + REVIEW_PERIOD_MS;
    this.db.exec('BEGIN');
    try {
      const cycleResult = this.db
        .prepare(
          'INSERT INTO review_cycles (database, opened_at, deadline) VALUES (?, ?, ?)',
        )
        .run(database, now, deadline);
      const cycleId = Number(cycleResult.lastInsertRowid);
      const grants = this.db
        .prepare('SELECT id FROM grants WHERE database = ? AND revoked = 0')
        .all(database) as unknown as Array<{ id: number }>;
      const insertEntry = this.db.prepare(
        'INSERT INTO review_entries (cycle_id, grant_id) VALUES (?, ?)',
      );
      const entryIds: number[] = [];
      for (const grant of grants) {
        const entryResult = insertEntry.run(cycleId, grant.id);
        entryIds.push(Number(entryResult.lastInsertRowid));
      }
      this.db.exec('COMMIT');
      return { cycleId, database, openedAt: now, deadline, entryIds };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  submitDecisions(decisions: DecisionInput[], now: number): void {
    checkAndAdvanceClock(this.db, now);
    this.db.exec('BEGIN');
    try {
      const getEntry = this.db.prepare(
        'SELECT id, cycle_id, grant_id, status FROM review_entries WHERE id = ?',
      );
      const setEntryStatus = this.db.prepare(
        'UPDATE review_entries SET status = ?, decided_at = ? WHERE id = ?',
      );
      const revokeGrant = this.db.prepare(
        'UPDATE grants SET revoked = 1 WHERE id = ?',
      );
      for (const { entryId, decision } of decisions) {
        const targetStatus = DECISION_TO_STATUS[decision];
        if (targetStatus === undefined) {
          throw new Error(`unknown decision: ${String(decision)}`);
        }
        const entry = getEntry.get(entryId) as EntryRow | undefined;
        if (entry === undefined) {
          throw new Error(`review entry not found: ${entryId}`);
        }
        if (entry.status !== 'pending') {
          if (entry.status === targetStatus) {
            continue;
          }
          throw new Error(
            `review entry ${entryId} already finalized as ${entry.status}; cannot change to ${targetStatus}`,
          );
        }
        setEntryStatus.run(targetStatus, now, entryId);
        if (targetStatus === 'revoked') {
          revokeGrant.run(entry.grant_id);
        }
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getGrantStatus(grantId: number, now: number): GrantState {
    checkAndAdvanceClock(this.db, now);
    const grant = this.db
      .prepare('SELECT id, user, database, role, revoked FROM grants WHERE id = ?')
      .get(grantId) as GrantRow | undefined;
    if (grant === undefined) {
      throw new Error(`grant not found: ${grantId}`);
    }
    const revoked = grant.revoked === 1;
    const overdue = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM review_entries e
         JOIN review_cycles c ON c.id = e.cycle_id
         WHERE e.grant_id = ? AND e.status = 'pending' AND c.deadline <= ?`,
      )
      .get(grantId, now) as { n: number };
    const suspended = !revoked && overdue.n > 0;
    const status = revoked ? 'revoked' : suspended ? 'suspended' : 'active';
    return {
      grantId: grant.id,
      user: grant.user,
      database: grant.database,
      role: grant.role,
      status,
      revoked,
      suspended,
    };
  }
}
