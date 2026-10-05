import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, inWriteTransaction } from './db';
import {
  groupInvitationsByEmployee,
  groupShiftsByEmployee,
  Interval,
  OccupancyLedger,
} from './ledger';
import {
  CreateInvitationRequest,
  Employee,
  InvitationMutationRequest,
  InvitationRecord,
  InvitationStatus,
  Minute,
  Opening,
  Result,
  StaticContext,
} from './types';

export interface ShiftCoverServiceOptions {
  dbPath: string;
  context: StaticContext;
}

const PENDING_TTL_MINUTES = 120;

interface InvitationRow {
  id: string;
  idempotency_key: string;
  opening_id: string;
  employee_id: string;
  start_minute: number;
  end_minute: number;
  status: string;
  created_minute: number;
  deadline_minute: number;
  updated_minute: number;
}

function rowToRecord(row: InvitationRow): InvitationRecord {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    openingId: row.opening_id,
    employeeId: row.employee_id,
    start: row.start_minute,
    end: row.end_minute,
    status: row.status as InvitationStatus,
    createdAt: row.created_minute,
    deadline: row.deadline_minute,
    updatedAt: row.updated_minute,
  };
}

export class ShiftCoverService {
  private readonly db: DatabaseSync;
  private readonly employeesById: Map<string, Employee>;
  private readonly openingsById: Map<string, Opening>;
  private readonly shiftsByEmployee: Map<string, Interval[]>;

  constructor(options: ShiftCoverServiceOptions) {
    this.db = openDatabase(options.dbPath);
    this.employeesById = new Map(options.context.employees.map((e) => [e.id, e]));
    this.openingsById = new Map(options.context.openings.map((o) => [o.id, o]));
    this.shiftsByEmployee = groupShiftsByEmployee(options.context.fixedShifts);
  }

  /** 查看某空缺当前全部可邀员工；不产生任何预留。 */
  getCandidates(openingId: string, now: Minute): string[] {
    const opening = this.openingsById.get(openingId);
    if (!opening) return [];
    const active = this.loadActiveInvitations(now);
    // 空缺已有有效邀约（任一员工）则无可邀候选人。
    if (active.some((inv) => inv.openingId === openingId)) return [];
    const activeByEmployee = groupInvitationsByEmployee(active);
    const candidates: string[] = [];
    for (const employee of this.employeesById.values()) {
      if (!this.isQualified(employee, opening)) continue;
      const ledger = this.buildLedger(employee.id, activeByEmployee);
      if (ledger.hasOverlap(opening.start, opening.end)) continue;
      if (!ledger.fitsWeeklyCap(opening.start, opening.end)) continue;
      candidates.push(employee.id);
    }
    return candidates;
  }

  /** 发起邀约：重新检查资格、冲突、每周额度与空缺占用。 */
  createInvitation(req: CreateInvitationRequest): Result<{ invitationId: string }> {
    const fingerprint = JSON.stringify({
      op: 'create',
      openingId: req.openingId,
      employeeId: req.employeeId,
    });
    return this.executeIdempotent(req.idempotencyKey, fingerprint, req.now, () =>
      this.doCreateInvitation(req),
    );
  }

  /** 接受邀约：仅对未过期的待答复邀约有效。 */
  acceptInvitation(req: InvitationMutationRequest): Result<Record<string, never>> {
    return this.mutateInvitation(req, 'accept');
  }

  /** 拒绝邀约：仅对未过期的待答复邀约有效。 */
  declineInvitation(req: InvitationMutationRequest): Result<Record<string, never>> {
    return this.mutateInvitation(req, 'decline');
  }

  /** 取消邀约：待答复（未过期）与已接受邀约均可取消。 */
  cancelInvitation(req: InvitationMutationRequest): Result<Record<string, never>> {
    return this.mutateInvitation(req, 'cancel');
  }

  /** 当前全部有效邀约（未到期 pending + accepted）。 */
  listActiveInvitations(now: Minute): InvitationRecord[] {
    return this.loadActiveInvitations(now);
  }

  close(): void {
    this.db.close();
  }

  // ---- 内部实现 ----

  private isQualified(employee: Employee, opening: Opening): boolean {
    const owned = new Set(employee.qualifications);
    return opening.requiredQualifications.every((q) => owned.has(q));
  }

  private buildLedger(employeeId: string, activeByEmployee: Map<string, Interval[]>): OccupancyLedger {
    const intervals: Interval[] = [];
    const shifts = this.shiftsByEmployee.get(employeeId);
    if (shifts) intervals.push(...shifts);
    const invitations = activeByEmployee.get(employeeId);
    if (invitations) intervals.push(...invitations);
    return new OccupancyLedger(intervals);
  }

  private loadActiveInvitations(now: Minute): InvitationRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM invitations
         WHERE status = 'accepted' OR (status = 'pending' AND deadline_minute > ?)`,
      )
      .all(now) as InvitationRow[];
    return rows.map(rowToRecord);
  }

  /** 把已到期的待答复邀约落库为 expired（写事务内调用）。 */
  private sweepExpired(now: Minute): void {
    this.db
      .prepare(
        `UPDATE invitations SET status = 'expired', updated_minute = ?
         WHERE status = 'pending' AND deadline_minute <= ?`,
      )
      .run(now, now);
  }

  /**
   * 幂等执行框架：同一 key 同参数直接返回首次结果；同 key 不同参数拒绝；
   * 首次执行的结果（含失败）落库，保证重试与崩溃恢复后语义一致。
   */
  private executeIdempotent<T>(
    key: string,
    fingerprint: string,
    now: Minute,
    fn: () => Result<T>,
  ): Result<T> {
    return inWriteTransaction(this.db, () => {
      this.sweepExpired(now);
      const existing = this.db
        .prepare('SELECT fingerprint, response FROM idempotency_keys WHERE key = ?')
        .get(key) as { fingerprint: string; response: string } | undefined;
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          return { ok: false, reason: 'idempotency_conflict' } as Result<T>;
        }
        return JSON.parse(existing.response) as Result<T>;
      }
      const result = fn();
      this.db
        .prepare(
          'INSERT INTO idempotency_keys (key, fingerprint, response, created_minute) VALUES (?, ?, ?, ?)',
        )
        .run(key, fingerprint, JSON.stringify(result), now);
      return result;
    });
  }

  private doCreateInvitation(req: CreateInvitationRequest): Result<{ invitationId: string }> {
    const opening = this.openingsById.get(req.openingId);
    if (!opening) return { ok: false, reason: 'opening_not_found' };
    const employee = this.employeesById.get(req.employeeId);
    if (!employee) return { ok: false, reason: 'employee_not_found' };
    if (!this.isQualified(employee, opening)) return { ok: false, reason: 'not_qualified' };

    const active = this.loadActiveInvitations(req.now);
    if (active.some((inv) => inv.openingId === req.openingId)) {
      return { ok: false, reason: 'opening_occupied' };
    }
    const activeByEmployee = groupInvitationsByEmployee(active);
    const ledger = this.buildLedger(req.employeeId, activeByEmployee);
    if (ledger.hasOverlap(opening.start, opening.end)) {
      return { ok: false, reason: 'time_conflict' };
    }
    if (!ledger.fitsWeeklyCap(opening.start, opening.end)) {
      return { ok: false, reason: 'weekly_cap_exceeded' };
    }

    const invitationId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO invitations
         (id, idempotency_key, opening_id, employee_id, start_minute, end_minute,
          status, created_minute, deadline_minute, updated_minute)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(
        invitationId,
        req.idempotencyKey,
        req.openingId,
        req.employeeId,
        opening.start,
        opening.end,
        req.now,
        req.now + PENDING_TTL_MINUTES,
        req.now,
      );
    return { ok: true, value: { invitationId } };
  }

  private mutateInvitation(
    req: InvitationMutationRequest,
    op: 'accept' | 'decline' | 'cancel',
  ): Result<Record<string, never>> {
    const fingerprint = JSON.stringify({ op, invitationId: req.invitationId });
    return this.executeIdempotent(req.idempotencyKey, fingerprint, req.now, () =>
      this.doMutateInvitation(req, op),
    );
  }

  private doMutateInvitation(
    req: InvitationMutationRequest,
    op: 'accept' | 'decline' | 'cancel',
  ): Result<Record<string, never>> {
    const row = this.db
      .prepare('SELECT status FROM invitations WHERE id = ?')
      .get(req.invitationId) as { status: string } | undefined;
    if (!row) return { ok: false, reason: 'invitation_not_found' };

    let nextStatus: InvitationStatus;
    if (op === 'accept') {
      if (row.status !== 'pending') return { ok: false, reason: 'not_pending' };
      nextStatus = 'accepted';
    } else if (op === 'decline') {
      if (row.status !== 'pending') return { ok: false, reason: 'not_pending' };
      nextStatus = 'declined';
    } else {
      if (row.status !== 'pending' && row.status !== 'accepted') {
        return { ok: false, reason: 'not_cancellable' };
      }
      nextStatus = 'cancelled';
    }
    this.db
      .prepare('UPDATE invitations SET status = ?, updated_minute = ? WHERE id = ?')
      .run(nextStatus, req.now, req.invitationId);
    return { ok: true, value: {} };
  }
}
