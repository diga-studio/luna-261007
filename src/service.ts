import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from './db.ts';
import {
  INVITE_TTL_MINUTES,
  WEEKLY_CAP_MINUTES,
  overlaps,
  splitByWeek,
} from './time.ts';
import type {
  CancelResult,
  Failure,
  InviteResult,
  Minute,
  RespondResult,
  StaticData,
} from './types.ts';

interface GapRow {
  id: string;
  start_min: number;
  end_min: number;
  required_quals: string;
}

interface IntervalRow {
  start_min: number;
  end_min: number;
}

interface EmployeeLoad {
  intervals: Array<[number, number]>;
  weekMinutes: Map<number, number>;
}

function addInterval(load: EmployeeLoad, startMin: number, endMin: number): void {
  load.intervals.push([startMin, endMin]);
  for (const slice of splitByWeek(startMin, endMin)) {
    load.weekMinutes.set(
      slice.week,
      (load.weekMinutes.get(slice.week) ?? 0) + slice.minutes,
    );
  }
}

function emptyLoad(): EmployeeLoad {
  return { intervals: [], weekMinutes: new Map() };
}

export class InviteService {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = openDatabase(dbPath);
  }

  /** 写入上层提供的静态数据；已配置过时为无操作。 */
  configure(data: StaticData): void {
    this.runTx(() => {
      const configured = this.db
        .prepare(`SELECT value FROM meta WHERE key = 'configured'`)
        .get();
      if (configured) return;
      const insertEmployee = this.db.prepare(
        'INSERT INTO employees (id, quals) VALUES (?, ?)',
      );
      for (const employee of data.employees) {
        insertEmployee.run(employee.id, JSON.stringify(employee.qualifications));
      }
      const insertShift = this.db.prepare(
        'INSERT INTO shifts (id, employee_id, start_min, end_min) VALUES (?, ?, ?, ?)',
      );
      for (const shift of data.shifts) {
        insertShift.run(shift.id, shift.employeeId, shift.startMin, shift.endMin);
      }
      const insertGap = this.db.prepare(
        'INSERT INTO gaps (id, start_min, end_min, required_quals) VALUES (?, ?, ?, ?)',
      );
      for (const gap of data.gaps) {
        insertGap.run(
          gap.id,
          gap.startMin,
          gap.endMin,
          JSON.stringify(gap.requiredQualifications),
        );
      }
      this.db
        .prepare(`INSERT INTO meta (key, value) VALUES ('configured', '1')`)
        .run();
    });
  }

  /** 返回某空缺在当前时刻下全部可邀员工 id（不产生预留）。 */
  getCandidates(gapId: string, nowMin: Minute): string[] {
    const gap = this.getGap(gapId);
    if (!gap) return [];
    if (this.isGapOccupied(gapId, nowMin)) return [];
    const required = JSON.parse(gap.required_quals) as string[];
    const loads = this.loadAllEmployeeLoads(nowMin);
    const gapSlices = splitByWeek(gap.start_min, gap.end_min);
    const candidates: string[] = [];
    const employees = this.db
      .prepare('SELECT id, quals FROM employees')
      .all() as unknown as Array<{ id: string; quals: string }>;
    for (const employee of employees) {
      const quals = new Set(JSON.parse(employee.quals) as string[]);
      if (!required.every((q) => quals.has(q))) continue;
      const load = loads.get(employee.id) ?? emptyLoad();
      const conflict = load.intervals.some(([s, e]) =>
        overlaps(s, e, gap.start_min, gap.end_min),
      );
      if (conflict) continue;
      const exceeds = gapSlices.some(
        (slice) =>
          (load.weekMinutes.get(slice.week) ?? 0) + slice.minutes >
          WEEKLY_CAP_MINUTES,
      );
      if (exceeds) continue;
      candidates.push(employee.id);
    }
    return candidates.sort();
  }

  invite(input: {
    key: string;
    gapId: string;
    employeeId: string;
    nowMin: Minute;
  }): InviteResult {
    const params = { gapId: input.gapId, employeeId: input.employeeId };
    return this.idempotent<InviteResult>(input.key, 'invite', params, () => {
      const gap = this.getGap(input.gapId);
      if (!gap) return fail('unknown_gap');
      const employee = this.db
        .prepare('SELECT quals FROM employees WHERE id = ?')
        .get(input.employeeId) as unknown as { quals: string } | undefined;
      if (!employee) return fail('unknown_employee');
      const required = JSON.parse(gap.required_quals) as string[];
      const quals = new Set(JSON.parse(employee.quals) as string[]);
      if (!required.every((q) => quals.has(q))) return fail('unqualified');
      if (this.isGapOccupied(input.gapId, input.nowMin)) {
        return fail('gap_occupied');
      }
      const load = this.loadEmployeeLoad(input.employeeId, input.nowMin);
      const conflict = load.intervals.some(([s, e]) =>
        overlaps(s, e, gap.start_min, gap.end_min),
      );
      if (conflict) return fail('overlap');
      const exceeds = splitByWeek(gap.start_min, gap.end_min).some(
        (slice) =>
          (load.weekMinutes.get(slice.week) ?? 0) + slice.minutes >
          WEEKLY_CAP_MINUTES,
      );
      if (exceeds) return fail('weekly_cap_exceeded');
      const invitationId = randomUUID();
      const deadlineMin = input.nowMin + INVITE_TTL_MINUTES;
      this.db
        .prepare(
          `INSERT INTO invitations
             (id, gap_id, employee_id, status, created_min, deadline_min)
           VALUES (?, ?, ?, 'pending', ?, ?)`,
        )
        .run(invitationId, input.gapId, input.employeeId, input.nowMin, deadlineMin);
      return { ok: true, invitationId, deadlineMin };
    });
  }

  respond(input: {
    key: string;
    invitationId: string;
    accept: boolean;
    nowMin: Minute;
  }): RespondResult {
    const params = { invitationId: input.invitationId, accept: input.accept };
    return this.idempotent<RespondResult>(input.key, 'respond', params, () => {
      const invitation = this.getInvitation(input.invitationId);
      if (!invitation) return fail('unknown_invitation');
      if (invitation.status !== 'pending') return fail('not_respondable');
      if (input.nowMin >= invitation.deadline_min) return fail('expired');
      this.db
        .prepare('UPDATE invitations SET status = ? WHERE id = ?')
        .run(input.accept ? 'accepted' : 'rejected', input.invitationId);
      return { ok: true };
    });
  }

  cancel(input: {
    key: string;
    invitationId: string;
    nowMin: Minute;
  }): CancelResult {
    const params = { invitationId: input.invitationId };
    return this.idempotent<CancelResult>(input.key, 'cancel', params, () => {
      const invitation = this.getInvitation(input.invitationId);
      if (!invitation) return fail('unknown_invitation');
      if (invitation.status !== 'pending' && invitation.status !== 'accepted') {
        return fail('not_cancellable');
      }
      this.db
        .prepare(`UPDATE invitations SET status = 'cancelled' WHERE id = ?`)
        .run(input.invitationId);
      return { ok: true };
    });
  }

  close(): void {
    this.db.close();
  }

  private getGap(gapId: string): GapRow | undefined {
    return this.db
      .prepare('SELECT id, start_min, end_min, required_quals FROM gaps WHERE id = ?')
      .get(gapId) as unknown as GapRow | undefined;
  }

  private getInvitation(
    invitationId: string,
  ): { status: string; deadline_min: number } | undefined {
    return this.db
      .prepare('SELECT status, deadline_min FROM invitations WHERE id = ?')
      .get(invitationId) as unknown as
      | { status: string; deadline_min: number }
      | undefined;
  }

  /** 有效邀约 = 已接受，或未到期（deadline > now）的待答复。 */
  private isGapOccupied(gapId: string, nowMin: Minute): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS x FROM invitations
         WHERE gap_id = ?
           AND (status = 'accepted'
                OR (status = 'pending' AND deadline_min > ?))
         LIMIT 1`,
      )
      .get(gapId, nowMin);
    return row !== undefined;
  }

  private loadEmployeeLoad(employeeId: string, nowMin: Minute): EmployeeLoad {
    const load = emptyLoad();
    const shifts = this.db
      .prepare('SELECT start_min, end_min FROM shifts WHERE employee_id = ?')
      .all(employeeId) as unknown as IntervalRow[];
    for (const shift of shifts) {
      addInterval(load, shift.start_min, shift.end_min);
    }
    const invitations = this.db
      .prepare(
        `SELECT g.start_min, g.end_min FROM invitations i
         JOIN gaps g ON g.id = i.gap_id
         WHERE i.employee_id = ?
           AND (i.status = 'accepted'
                OR (i.status = 'pending' AND i.deadline_min > ?))`,
      )
      .all(employeeId, nowMin) as unknown as IntervalRow[];
    for (const invitation of invitations) {
      addInterval(load, invitation.start_min, invitation.end_min);
    }
    return load;
  }

  private loadAllEmployeeLoads(nowMin: Minute): Map<string, EmployeeLoad> {
    const loads = new Map<string, EmployeeLoad>();
    const obtain = (employeeId: string): EmployeeLoad => {
      let load = loads.get(employeeId);
      if (!load) {
        load = emptyLoad();
        loads.set(employeeId, load);
      }
      return load;
    };
    const shifts = this.db
      .prepare('SELECT employee_id, start_min, end_min FROM shifts')
      .all() as unknown as Array<IntervalRow & { employee_id: string }>;
    for (const shift of shifts) {
      addInterval(obtain(shift.employee_id), shift.start_min, shift.end_min);
    }
    const invitations = this.db
      .prepare(
        `SELECT i.employee_id, g.start_min, g.end_min FROM invitations i
         JOIN gaps g ON g.id = i.gap_id
         WHERE i.status = 'accepted'
            OR (i.status = 'pending' AND i.deadline_min > ?)`,
      )
      .all(nowMin) as unknown as Array<IntervalRow & { employee_id: string }>;
    for (const invitation of invitations) {
      addInterval(
        obtain(invitation.employee_id),
        invitation.start_min,
        invitation.end_min,
      );
    }
    return loads;
  }

  private runTx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * 幂等执行：同键同业务参数返回首次结果；同键不同参数拒绝。
   * 调用时间不参与参数比较。整个判定与执行在同一事务内完成，
   * 并发下同键只会执行一次。
   */
  private idempotent<T extends InviteResult | RespondResult | CancelResult>(
    key: string,
    op: string,
    params: unknown,
    execute: () => T,
  ): T {
    return this.runTx(() => {
      const paramsJson = JSON.stringify(params);
      const existing = this.db
        .prepare('SELECT op, params, response FROM idempotency WHERE key = ?')
        .get(key) as unknown as
        | { op: string; params: string; response: string }
        | undefined;
      if (existing) {
        if (existing.op === op && existing.params === paramsJson) {
          return JSON.parse(existing.response) as T;
        }
        return fail('idempotency_key_conflict') as T;
      }
      const result = execute();
      this.db
        .prepare(
          'INSERT INTO idempotency (key, op, params, response) VALUES (?, ?, ?, ?)',
        )
        .run(key, op, paramsJson, JSON.stringify(result));
      return result;
    });
  }
}

function fail(reason: Failure['reason']): Failure {
  return { ok: false, reason };
}
