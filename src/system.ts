import { Store } from "./db.js";
import type {
  ClassConfig,
  ClassState,
  EnrollmentRequest,
  OperationResult,
  RequestStatus,
  StudentState,
} from "./types.js";

interface ClassInfo {
  classId: string;
  capacity: number;
  startMin: number;
  endMin: number;
  /** 已选学生：studentId -> seq */
  enrolled: Map<string, number>;
  /** 候补学生：studentId -> seq */
  waitlisted: Map<string, number>;
}

interface RequestRec {
  seq: number;
  studentId: string;
  classId: string;
  status: RequestStatus;
}

/**
 * 选课与候补回填系统。
 *
 * 所有公开方法均为同步方法：一次选/退课连同其触发的全部回填在同一个
 * 同步执行片段与同一个 SQLite 事务中完成，事件循环不会在中途插入其他
 * 请求，因此并发调用的结果天然等价于按实际完成先后排列的串行执行，
 * 查询也不可能观察到中间状态。
 */
export class EnrollmentSystem {
  private store!: Store;
  private classes = new Map<string, ClassInfo>();
  private requests = new Map<number, RequestRec>();
  /** studentId -> (classId -> seq)，仅含有效申请。 */
  private byStudent = new Map<string, Map<string, number>>();
  private nextSeq = 1;

  private constructor() {}

  /** 以给定班级配置创建新库（库中已有班级时报错）。 */
  static create(dbPath: string, classes: ClassConfig[]): EnrollmentSystem {
    const seen = new Set<string>();
    for (const c of classes) {
      if (seen.has(c.classId)) {
        throw new Error(`duplicate classId: ${c.classId}`);
      }
      seen.add(c.classId);
      if (!Number.isInteger(c.capacity) || c.capacity < 1 || c.capacity > 30) {
        throw new Error(`capacity out of range [1,30] for class ${c.classId}`);
      }
      if (
        !Number.isInteger(c.startMin) ||
        !Number.isInteger(c.endMin) ||
        c.endMin <= c.startMin
      ) {
        throw new Error(`invalid time range for class ${c.classId}`);
      }
    }
    const sys = new EnrollmentSystem();
    sys.store = new Store(dbPath);
    if (sys.store.hasClasses()) {
      sys.store.close();
      throw new Error("database already initialized; use EnrollmentSystem.open");
    }
    sys.store.insertClasses(classes);
    for (const c of classes) {
      sys.classes.set(c.classId, {
        classId: c.classId,
        capacity: c.capacity,
        startMin: c.startMin,
        endMin: c.endMin,
        enrolled: new Map(),
        waitlisted: new Map(),
      });
    }
    return sys;
  }

  /** 打开已有库并载入状态。 */
  static open(dbPath: string): EnrollmentSystem {
    const sys = new EnrollmentSystem();
    sys.store = new Store(dbPath);
    sys.reloadFromStore();
    return sys;
  }

  /** 从 SQLite 重建全部内存状态。 */
  private reloadFromStore(): void {
    this.classes.clear();
    this.requests.clear();
    this.byStudent.clear();
    for (const c of this.store.loadClasses()) {
      this.classes.set(c.classId, {
        classId: c.classId,
        capacity: c.capacity,
        startMin: c.startMin,
        endMin: c.endMin,
        enrolled: new Map(),
        waitlisted: new Map(),
      });
    }
    for (const r of this.store.loadRequests()) {
      this.requests.set(r.seq, { ...r });
      const info = this.mustClass(r.classId);
      (r.status === "enrolled" ? info.enrolled : info.waitlisted).set(
        r.studentId,
        r.seq,
      );
      let byClass = this.byStudent.get(r.studentId);
      if (!byClass) {
        byClass = new Map();
        this.byStudent.set(r.studentId, byClass);
      }
      byClass.set(r.classId, r.seq);
    }
    this.nextSeq = this.store.maxSeq() + 1;
  }

  private mustClass(classId: string): ClassInfo {
    const info = this.classes.get(classId);
    if (!info) throw new Error(`unknown classId: ${classId}`);
    return info;
  }

  /** 两个时段是否冲突：含起点、不含终点，首尾相接不算冲突。 */
  private static overlaps(
    aStart: number,
    aEnd: number,
    bStart: number,
    bEnd: number,
  ): boolean {
    return aStart < bEnd && bStart < aEnd;
  }

  /**
   * 候补当前是否具备晋级资格：班级尚有空位，且晋级后不与该学生
   * 任何已选班级时间冲突。
   */
  private isEligible(rec: RequestRec): boolean {
    const info = this.mustClass(rec.classId);
    if (info.enrolled.size >= info.capacity) return false;
    const byClass = this.byStudent.get(rec.studentId);
    if (!byClass) return true;
    for (const [otherClassId, seq] of byClass) {
      const other = this.requests.get(seq);
      if (!other || other.status !== "enrolled") continue;
      const otherInfo = this.mustClass(otherClassId);
      if (
        EnrollmentSystem.overlaps(
          info.startMin,
          info.endMin,
          otherInfo.startMin,
          otherInfo.endMin,
        )
      ) {
        return false;
      }
    }
    return true;
  }

  /**
   * 回填：在候选候补（资格可能因本次变化而改观的申请）中，反复晋级
   * 受理序号最小且当前具备资格者，直到不存在可晋级的候补。
   *
   * 晋级只会消耗空位、增加学生的时间冲突，不会使任何其他候补新获得
   * 资格，因此候选集合之外不存在可被晋级的候补，循环必然终止。
   */
  private backfill(candidates: Set<number>, dbOps: Array<() => void>): void {
    for (;;) {
      let best = -1;
      for (const seq of candidates) {
        const rec = this.requests.get(seq);
        if (!rec || rec.status !== "waitlisted") {
          candidates.delete(seq);
          continue;
        }
        if (!this.isEligible(rec)) continue;
        if (best === -1 || seq < best) best = seq;
      }
      if (best === -1) return;
      candidates.delete(best);
      const rec = this.requests.get(best)!;
      rec.status = "enrolled";
      const info = this.mustClass(rec.classId);
      info.waitlisted.delete(rec.studentId);
      info.enrolled.set(rec.studentId, rec.seq);
      dbOps.push(() => this.store.updateRequestStatus(rec.seq, "enrolled"));
    }
  }

  /** 将内存变更与落盘变更作为一个完整业务变化提交。 */
  private commit(dbOps: Array<() => void>): void {
    try {
      this.store.transaction(() => {
        for (const op of dbOps) op();
      });
    } catch (err) {
      // 落盘失败时以 SQLite 为准重建内存，避免状态分叉。
      this.reloadFromStore();
      throw err;
    }
  }

  /**
   * 选课：无有效申请则新建候补申请（取得新受理序号）并参与回填；
   * 已有有效申请（已选或候补）则幂等返回，不新增申请、不改变序号。
   */
  enroll(studentId: string, classId: string): OperationResult {
    const info = this.mustClass(classId);
    const existing = this.byStudent.get(studentId)?.get(classId);
    if (existing !== undefined) {
      const rec = this.requests.get(existing)!;
      return { status: rec.status, seq: rec.seq };
    }
    const dbOps: Array<() => void> = [];
    let seq = -1;
    dbOps.push(() => {
      seq = this.store.insertRequest(studentId, classId, "waitlisted");
    });
    // 先在内存中占位，序号以落盘结果为准；二者在同事务内一致。
    const memSeq = this.nextSeq;
    const rec: RequestRec = { seq: memSeq, studentId, classId, status: "waitlisted" };
    this.requests.set(memSeq, rec);
    info.waitlisted.set(studentId, memSeq);
    let byClass = this.byStudent.get(studentId);
    if (!byClass) {
      byClass = new Map();
      this.byStudent.set(studentId, byClass);
    }
    byClass.set(classId, memSeq);
    this.backfill(new Set([memSeq]), dbOps);
    this.commit(dbOps);
    if (seq !== memSeq) {
      // SQLite 分配的序号与内存不一致（不应发生），以数据库为准重建。
      this.reloadFromStore();
      const real = this.byStudent.get(studentId)?.get(classId);
      const realRec = real !== undefined ? this.requests.get(real)! : undefined;
      return { status: realRec?.status ?? null, seq: realRec?.seq ?? null };
    }
    this.nextSeq = memSeq + 1;
    return { status: rec.status, seq: memSeq };
  }

  /** 退课：撤销该班有效申请（已选或候补），随后完成回填。 */
  drop(studentId: string, classId: string): OperationResult {
    this.mustClass(classId);
    const seq = this.byStudent.get(studentId)?.get(classId);
    if (seq === undefined) {
      return { status: null, seq: null };
    }
    const rec = this.requests.get(seq)!;
    const wasEnrolled = rec.status === "enrolled";
    const dbOps: Array<() => void> = [];
    dbOps.push(() => this.store.deleteRequest(seq));

    const info = this.mustClass(classId);
    info.enrolled.delete(studentId);
    info.waitlisted.delete(studentId);
    this.byStudent.get(studentId)?.delete(classId);
    this.requests.delete(seq);

    const candidates = new Set<number>();
    if (wasEnrolled) {
      // 本班空出座位：本班全部候补成为候选。
      for (const s of info.waitlisted.values()) candidates.add(s);
      // 该学生减少了一门已选：其所有候补的冲突资格可能改观。
      const byClass = this.byStudent.get(studentId);
      if (byClass) {
        for (const s of byClass.values()) candidates.add(s);
      }
    }
    this.backfill(candidates, dbOps);
    this.commit(dbOps);
    return { status: null, seq };
  }

  /** 查询学生当前已选与候补（按受理序号升序）。 */
  getStudentState(studentId: string): StudentState {
    const enrolled: EnrollmentRequest[] = [];
    const waitlisted: EnrollmentRequest[] = [];
    const byClass = this.byStudent.get(studentId);
    if (byClass) {
      for (const seq of byClass.values()) {
        const rec = this.requests.get(seq);
        if (!rec) continue;
        (rec.status === "enrolled" ? enrolled : waitlisted).push({ ...rec });
      }
    }
    enrolled.sort((a, b) => a.seq - b.seq);
    waitlisted.sort((a, b) => a.seq - b.seq);
    return { studentId, enrolled, waitlisted };
  }

  /** 查询班级当前已选与候补（按受理序号升序）。 */
  getClassState(classId: string): ClassState {
    const info = this.mustClass(classId);
    const enrolled: EnrollmentRequest[] = [];
    const waitlisted: EnrollmentRequest[] = [];
    for (const seq of info.enrolled.values()) {
      enrolled.push({ ...this.requests.get(seq)! });
    }
    for (const seq of info.waitlisted.values()) {
      waitlisted.push({ ...this.requests.get(seq)! });
    }
    enrolled.sort((a, b) => a.seq - b.seq);
    waitlisted.sort((a, b) => a.seq - b.seq);
    return {
      classId,
      capacity: info.capacity,
      enrolled,
      waitlisted,
    };
  }

  close(): void {
    this.store.close();
  }
}
