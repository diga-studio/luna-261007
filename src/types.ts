/** 所有时刻均为 UTC 纪元分钟（精确到分钟）。区间含开始不含结束。 */
export type Minute = number;

export interface Interval {
  startMin: Minute;
  endMin: Minute;
}

export interface Employee {
  id: string;
  qualifications: string[];
}

export interface FixedShift extends Interval {
  id: string;
  employeeId: string;
}

export interface Gap extends Interval {
  id: string;
  requiredQualifications: string[];
}

/** 上层排班系统提供的静态数据，运行期间不变且已合法。 */
export interface StaticData {
  employees: Employee[];
  shifts: FixedShift[];
  gaps: Gap[];
}

export type InvitationStatus = 'pending' | 'accepted' | 'rejected' | 'cancelled';

export interface Invitation {
  id: string;
  gapId: string;
  employeeId: string;
  status: InvitationStatus;
  createdMin: Minute;
  deadlineMin: Minute;
}

export type FailureReason =
  | 'idempotency_key_conflict'
  | 'unknown_gap'
  | 'unknown_employee'
  | 'unknown_invitation'
  | 'unqualified'
  | 'overlap'
  | 'weekly_cap_exceeded'
  | 'gap_occupied'
  | 'expired'
  | 'not_respondable'
  | 'not_cancellable';

export interface InviteSuccess {
  ok: true;
  invitationId: string;
  deadlineMin: Minute;
}

export interface Failure {
  ok: false;
  reason: FailureReason;
}

export type InviteResult = InviteSuccess | Failure;
export type RespondResult = { ok: true } | Failure;
export type CancelResult = { ok: true } | Failure;
