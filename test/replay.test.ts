import assert from "node:assert/strict";
import { test } from "node:test";
import { EnrollmentService, type ClassDef } from "../src/index.js";
import {
  ReferenceModel,
  assertInvariants,
  dumpService,
  makeRng,
} from "./helpers.js";

/**
 * 小规模连续选退课：每一步操作后，被测实现的全量状态
 * 必须与参考模型从头按受理序号推演的结果完全一致。
 */
test("随机连续选退课与参考模型逐步一致", () => {
  const rng = makeRng(20261007);
  const classCount = 8;
  const studentCount = 10;
  const opCount = 400;

  const classes: ClassDef[] = [];
  for (let i = 0; i < classCount; i += 1) {
    const start = Math.floor(rng() * 20) * 30; // 0..570
    const len = (1 + Math.floor(rng() * 4)) * 30; // 30..120
    classes.push({
      classId: `C${i}`,
      capacity: 1 + Math.floor(rng() * 3), // 1..3
      startMin: start,
      endMin: start + len,
    });
  }
  const classIds = classes.map((c) => c.classId);
  const studentIds = Array.from({ length: studentCount }, (_, i) => `S${i}`);

  const svc = new EnrollmentService(":memory:", classes);
  const ref = new ReferenceModel(classes);

  for (let step = 0; step < opCount; step += 1) {
    const studentId = studentIds[Math.floor(rng() * studentCount)];
    const classId = classIds[Math.floor(rng() * classCount)];
    if (rng() < 0.6) {
      svc.enroll(studentId, classId);
      ref.enroll(studentId, classId);
    } else {
      svc.drop(studentId, classId);
      ref.drop(studentId, classId);
    }
    assert.deepEqual(
      dumpService(svc, classIds),
      ref.dump(),
      `step ${step} diverged`,
    );
  }

  assertInvariants(svc, classes, studentIds);
  svc.close();
});

test("多种子重放均一致", () => {
  for (const seed of [1, 7, 42, 999]) {
    const rng = makeRng(seed);
    const classes: ClassDef[] = [];
    for (let i = 0; i < 5; i += 1) {
      const start = Math.floor(rng() * 10) * 45;
      classes.push({
        classId: `C${i}`,
        capacity: 1 + Math.floor(rng() * 2),
        startMin: start,
        endMin: start + 90,
      });
    }
    const classIds = classes.map((c) => c.classId);
    const studentIds = ["a", "b", "c", "d"];
    const svc = new EnrollmentService(":memory:", classes);
    const ref = new ReferenceModel(classes);
    for (let step = 0; step < 150; step += 1) {
      const s = studentIds[Math.floor(rng() * studentIds.length)];
      const c = classIds[Math.floor(rng() * classIds.length)];
      if (rng() < 0.5) {
        svc.enroll(s, c);
        ref.enroll(s, c);
      } else {
        svc.drop(s, c);
        ref.drop(s, c);
      }
    }
    assert.deepEqual(dumpService(svc, classIds), ref.dump(), `seed ${seed}`);
    svc.close();
  }
});
