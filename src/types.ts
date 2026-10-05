/** 分钟级 UTC 时间戳：自 Unix epoch 起的整数分钟。 */
export type Minute = number;

/** 员工：上层提供的静态资格信息。 */
export interface Employee {
  id: string;
  qualifications: string[];
}

/** 固定排班：半开区间 [start, end)。 */
export interface FixedShift {
  employeeId: string;
  start: Minute;
  end: Minute;
}

/** 待补空缺：一段连续时间 + 必需资格。 */
export interface Opening {
  id: string;
  start: Minute;
  end: Minute;
  requiredQualifications: string[];
}

/** 上层在构造时一次性提供的静态上下文，运行期间不变且已合法。 */
export interface StaticContext {
  employees: Employee[];
  fixedShifts: FixedShift[];
  openings: Opening[];
}

/** 邀约在库中的持久化状态。 */
export type InvitationStatus =
  | 'pending'
  | 'accepted'
  | 'declined'
  | 'cancelled'
  | 'expired';

/** 邀约记录（从 SQLite 读出的行）。 */
export interface InvitationRecord {
  id: string;
  idempotencyKey: string;
  openingId: string;
  employeeId: string;
  start: Minute;
  end: Minute;
  status: InvitationStatus;
  createdAt: Minute;
  deadline: Minute;
  updatedAt: Minute;
}

export type FailureReason =
  | 'opening_not_found'
  | 'employee_not_found'
  | 'not_qualified'
  | 'opening_occupied'
  | 'time_conflict'
  | 'weekly_cap_exceeded'
  | 'invitation_not_found'
  | 'not_pending'
  | 'not_cancellable'
  | 'idempotency_conflict';

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; reason: FailureReason };

export interface CreateInvitationRequest {
  idempotencyKey: string;
  openingId: string;
  employeeId: string;
  now: Minute;
}

export interface InvitationMutationRequest {
  idempotencyKey: string;
  invitationId: string;
  now: Minute;
}
