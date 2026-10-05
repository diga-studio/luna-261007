/** 班级配置：本轮固定，由上层教务系统提供。 */
export interface ClassConfig {
  /** 班级 ID（上层业务主键）。 */
  classId: string;
  /** 容量，1..30。 */
  capacity: number;
  /** 上课时段起点（分钟，含）。 */
  startMin: number;
  /** 上课时段终点（分钟，不含）。 */
  endMin: number;
}

/** 一条有效申请的状态。 */
export type RequestStatus = "enrolled" | "waitlisted";

/** 一条有效申请（已选或候补）。 */
export interface EnrollmentRequest {
  /** 本轮唯一递增受理序号。 */
  seq: number;
  studentId: string;
  classId: string;
  status: RequestStatus;
}

/** 学生视角的当前状态。 */
export interface StudentState {
  studentId: string;
  enrolled: EnrollmentRequest[];
  waitlisted: EnrollmentRequest[];
}

/** 班级视角的当前状态。 */
export interface ClassState {
  classId: string;
  capacity: number;
  enrolled: EnrollmentRequest[];
  waitlisted: EnrollmentRequest[];
}

/** 选课/退课操作结果。 */
export interface OperationResult {
  /** 操作后该学生在该班的状态；无有效申请时为 null。 */
  status: RequestStatus | null;
  /** 本次操作涉及申请的受理序号；无有效申请时为 null。 */
  seq: number | null;
}
