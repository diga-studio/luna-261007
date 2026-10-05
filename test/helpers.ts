import type { Application, ClassDef } from "../src/index.js";
import { EnrollmentService } from "../src/index.js";

/** 可复现的伪随机数发生器（mulberry32）。 */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface RefApp {
  seq: number;
  studentId: string;
  classId: string;
  status: "enrolled" | "waitlisted";
}

/**
 * 参考模型：纯内存、严格按规格语文实现。
 * 回填采用最朴素的全局循环（每轮找受理序号最小且具备资格的候补），
 * 与被测实现的单趟扫描优化互为交叉验证。
 */
export class ReferenceModel {
  private readonly classes = new Map<string, ClassDef>();
  private readonly apps = new Map<number, RefApp>();
  private nextSeq = 1;

  constructor(classes: ClassDef[]) {
    for (const c of classes) this.classes.set(c.classId, c);
  }

  enroll(studentId: string, classId: string): void {
    for (const app of this.apps.values()) {
      if (app.studentId === studentId && app.classId === classId) return;
    }
    this.apps.set(this.nextSeq, {
      seq: this.nextSeq,
      studentId,
      classId,
      status: "waitlisted",
    });
    this.nextSeq += 1;
    this.backfill();
  }

  drop(studentId: string, classId: string): void {
    for (const app of this.apps.values()) {
      if (app.studentId === studentId && app.classId === classId) {
        this.apps.delete(app.seq);
        break;
      }
    }
    this.backfill();
  }

  dump(): Application[] {
    return [...this.apps.values()]
      .sort((x, y) => x.seq - y.seq)
      .map((a) => ({ ...a }));
  }

  private enrolledCount(classId: string): number {
    let n = 0;
    for (const app of this.apps.values()) {
      if (app.classId === classId && app.status === "enrolled") n += 1;
    }
    return n;
  }

  private eligible(app: RefApp): boolean {
    const cls = this.classes.get(app.classId)!;
    for (const other of this.apps.values()) {
      if (
        other.studentId === app.studentId &&
        other.status === "enrolled"
      ) {
        const oc = this.classes.get(other.classId)!;
        if (oc.startMin < cls.endMin && oc.endMin > cls.startMin) return false;
      }
    }
    return true;
  }

  private backfill(): void {
    for (;;) {
      let best: RefApp | null = null;
      for (const app of this.apps.values()) {
        if (app.status !== "waitlisted") continue;
        const cls = this.classes.get(app.classId)!;
        if (this.enrolledCount(app.classId) >= cls.capacity) continue;
        if (!this.eligible(app)) continue;
        if (!best || app.seq < best.seq) best = app;
      }
      if (!best) return;
      best.status = "enrolled";
    }
  }
}

/** 从被测服务导出全量申请状态（按受理序号排序）。 */
export function dumpService(
  svc: EnrollmentService,
  classIds: string[],
): Application[] {
  const all: Application[] = [];
  for (const classId of classIds) {
    const st = svc.getClassStatus(classId);
    all.push(...st.enrolled, ...st.waitlisted);
  }
  return all.sort((a, b) => a.seq - b.seq);
}

/** 校验业务不变量：容量、学生时间冲突、空位与可晋级候补不得共存。 */
export function assertInvariants(
  svc: EnrollmentService,
  classes: ClassDef[],
  studentIds: string[],
): void {
  const byClass = new Map(classes.map((c) => [c.classId, c]));
  for (const c of classes) {
    const st = svc.getClassStatus(c.classId);
    if (st.enrolledCount > c.capacity) {
      throw new Error(`class ${c.classId} over capacity`);
    }
    if (st.enrolled.length !== st.enrolledCount) {
      throw new Error(`class ${c.classId} enrolled_count mismatch`);
    }
  }
  for (const studentId of studentIds) {
    const st = svc.getStudentStatus(studentId);
    const times = st.enrolled.map((a) => byClass.get(a.classId)!);
    for (let i = 0; i < times.length; i += 1) {
      for (let j = i + 1; j < times.length; j += 1) {
        if (
          times[i].startMin < times[j].endMin &&
          times[j].startMin < times[i].endMin
        ) {
          throw new Error(`student ${studentId} has conflicting enrollments`);
        }
      }
    }
    // 有空位的班级里，该学生的候补必须都因冲突而不具备资格
    for (const w of st.waitlisted) {
      const cls = byClass.get(w.classId)!;
      const cs = svc.getClassStatus(w.classId);
      if (cs.enrolledCount < cls.capacity) {
        const conflict = times.some(
          (t) => t.startMin < cls.endMin && t.endMin > cls.startMin,
        );
        if (!conflict) {
          throw new Error(
            `student ${studentId} waitlisted on ${w.classId} which has free seats and no conflict`,
          );
        }
      }
    }
  }
}
