import assert from "node:assert/strict";
import { test } from "node:test";
import { makeRng, makeSystem, ReferenceModel, type Op } from "./helpers.js";

function runScenario(seed: number, steps: number): void {
  const rng = makeRng(seed);
  // 8 个班：容量 1-3，随机时段（粒度 30 分钟，范围 0-300）
  const classes = Array.from({ length: 8 }, (_, i) => {
    const start = Math.floor(rng() * 10) * 30;
    const len = (1 + Math.floor(rng() * 3)) * 30;
    return {
      classId: `C${i}`,
      capacity: 1 + Math.floor(rng() * 3),
      startMin: start,
      endMin: start + len,
    };
  });
  const students = Array.from({ length: 10 }, (_, i) => `s${i}`);
  const { sys } = makeSystem(`replay-${seed}`, classes);
  const ref = new ReferenceModel(classes);

  for (let step = 0; step < steps; step++) {
    const op: Op = {
      kind: rng() < 0.6 ? "enroll" : "drop",
      studentId: students[Math.floor(rng() * students.length)]!,
      classId: classes[Math.floor(rng() * classes.length)]!.classId,
    };
    if (op.kind === "enroll") sys.enroll(op.studentId, op.classId);
    else sys.drop(op.studentId, op.classId);
    ref.apply(op);

    // 每一步都与从头按受理序号推演的结果全量比对
    for (const s of students) {
      assert.deepEqual(
        sys.getStudentState(s),
        ref.studentState(s),
        `seed=${seed} step=${step} op=${JSON.stringify(op)} student=${s}`,
      );
    }
    for (const c of classes) {
      assert.deepEqual(
        sys.getClassState(c.classId),
        ref.classState(c.classId),
        `seed=${seed} step=${step} op=${JSON.stringify(op)} class=${c.classId}`,
      );
    }
  }
  sys.close();
}

test("小规模连续选退课：每步结果与从头推演一致（多组种子）", () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    runScenario(seed, 120);
  }
});
