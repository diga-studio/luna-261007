/** 班级（课程开班）定义，由上层教务系统在初始化时提供。 */
export interface ClassDef {
  /** 班级唯一标识。 */
  classId: string;
  /** 容量，最多 30 人。 */
  capacity: number;
  /** 上课时段起点（含），同一时间轴上的整数分钟。 */
  startMin: number;
  /** 上课时段终点（不含），首尾相接不算冲突。 */
  endMin: number;
}

/** 申请状态。 */
export type ApplicationStatus = "enrolled" | "waitlisted";

/** 一条有效申请（已选或候补）。 */
export interface Application {
  /** 本轮唯一递增受理序号。 */
  seq: number;
  studentId: string;
  classId: string;
  status: ApplicationStatus;
}

/** 学生视角的当前状态。 */
export interface StudentStatus {
  studentId: string;
  enrolled: Application[];
  waitlisted: Application[];
}

/** 班级视角的当前状态。 */
export interface ClassStatus {
  classId: string;
  capacity: number;
  enrolledCount: number;
  enrolled: Application[];
  waitlisted: Application[];
}

/** 选课/退课操作的结果。 */
export interface OperationResult {
  /** 本次操作后该学生在该班的状态；无有效申请时为 null。 */
  status: ApplicationStatus | null;
  /** 本次操作涉及的受理序号；无有效申请时为 null。 */
  seq: number | null;
}
