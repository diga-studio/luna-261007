import fs from "node:fs";
import { EnrollmentSystem } from "../src/index.js";
import type {
  ClassConfig,
  ClassState,
  StudentState,
} from "../src/index.js";

/** 一次操作：选课或退课。 */
export type Op =
  | { kind: "enroll"; studentId: string; classId: string }
  | { kind: "drop"; studentId: string; classId: string };

interface RefRequest {
  seq: number;
  studentId: string;
  classId: string;
  status: "enrolled" | "waitlisted";
}

/**
 * 参考实现：每一步都从头按受理序号推演。
 * 刻意写得简单直接（全量扫描），与被测实现相互独立。
 */
export class ReferenceModel {
  private requests: RefRequest[] = [];
  private nextSeq = 1;

  constructor(private readonly classes: ClassConfig[]) {}

  private classOf(classId: string): ClassConfig {
    const c = this.classes.find((x) => x.classId === classId);
    if (!c) throw new Error(`unknown classId: ${classId}`);
    return c;
  }

  private overlaps(a: ClassConfig, b: ClassConfig): boolean {
    return a.startMin < b.endMin && b.startMin < a.endMin;
  }

  /** 全量回填：反复找全局序号最小且具备资格的候补晋级。 */
  private backfill(): void {
    for (;;) {
      const candidate = this.requests
        .filter((r) => r.status === "waitlisted")
        .sort((a, b) => a.seq - b.seq)
        .find((r) => {
          const cls = this.classOf(r.classId);
          const enrolledCount = this.requests.filter(
            (x) => x.classId === r.classId && x.status === "enrolled",
          ).length;
          if (enrolledCount >= cls.capacity) return false;
          return !this.requests.some(
            (x) =>
              x.studentId === r.studentId &&
              x.status === "enrolled" &&
              this.overlaps(cls, this.classOf(x.classId)),
          );
        });
      if (!candidate) return;
      candidate.status = "enrolled";
    }
  }

  apply(op: Op): void {
    if (op.kind === "enroll") {
      const dup = this.requests.some(
        (r) => r.studentId === op.studentId && r.classId === op.classId,
      );
      if (!dup) {
        this.requests.push({
          seq: this.nextSeq++,
          studentId: op.studentId,
          classId: op.classId,
          status: "waitlisted",
        });
      }
    } else {
      this.requests = this.requests.filter(
        (r) => !(r.studentId === op.studentId && r.classId === op.classId),
      );
    }
    this.backfill();
  }

  studentState(studentId: string): StudentState {
    const mine = this.requests
      .filter((r) => r.studentId === studentId)
      .sort((a, b) => a.seq - b.seq);
    return {
      studentId,
      enrolled: mine.filter((r) => r.status === "enrolled").map((r) => ({ ...r })),
      waitlisted: mine
        .filter((r) => r.status === "waitlisted")
        .map((r) => ({ ...r })),
    };
  }

  classState(classId: string): ClassState {
    const cls = this.classOf(classId);
    const mine = this.requests
      .filter((r) => r.classId === classId)
      .sort((a, b) => a.seq - b.seq);
    return {
      classId,
      capacity: cls.capacity,
      enrolled: mine.filter((r) => r.status === "enrolled").map((r) => ({ ...r })),
      waitlisted: mine
        .filter((r) => r.status === "waitlisted")
        .map((r) => ({ ...r })),
    };
  }
}

/** 确定性伪随机数生成器（mulberry32）。 */
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

export function freshDbPath(name: string): string {
  const dir = `${process.cwd()}/dist/test-tmp`;
  fs.mkdirSync(dir, { recursive: true });
  return `${dir}/${name}-${Math.random().toString(36).slice(2)}.db`;
}

export function makeSystem(
  name: string,
  classes: ClassConfig[],
): { sys: EnrollmentSystem; dbPath: string } {
  const dbPath = freshDbPath(name);
  return { sys: EnrollmentSystem.create(dbPath, classes), dbPath };
}
