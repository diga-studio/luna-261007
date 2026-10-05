import assert from "node:assert/strict";
import { test } from "node:test";
import { EnrollmentService, type ClassDef } from "../src/index.js";
import {
  ReferenceModel,
  assertInvariants,
  dumpService,
  makeRng,
} from "./helpers.js";

/** 把同步调用包装成异步任务，模拟上层并发请求。 */
function asyncCall<T>(fn: () => T, onDone?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    setImmediate(() => {
      try {
        const r = fn();
        onDone?.();
        resolve(r);
      } catch (e) {
        reject(e);
      }
    });
  });
}

/** 校验"班级视角"一致性：不超容，且有空位时不存在可晋级的候补。 */
function checkClassConsistency(svc: EnrollmentService, classes: ClassDef[], classId: string): void {
  const byId = new Map(classes.map((c) => [c.classId, c]));
  const cs = svc.getClassStatus(classId);
  assert.ok(cs.enrolledCount <= cs.capacity, `${classId} over capacity`);
  if (cs.enrolledCount < cs.capacity) {
    const cls = byId.get(classId)!;
    for (const w of cs.waitlisted) {
      const st = svc.getStudentStatus(w.studentId);
      const conflict = st.enrolled.some((e) => {
        const ec = byId.get(e.classId)!;
        return ec.startMin < cls.endMin && ec.endMin > cls.startMin;
      });
      assert.ok(
        conflict,
        `${classId} has free seat but waitlisted ${w.studentId} is promotable (saw mid-backfill state)`,
      );
    }
  }
}

test("满班退课与新申请并发：新申请不越过可晋级的旧候补", async () => {
  for (const order of [0, 1]) {
    const classes: ClassDef[] = [
      { classId: "B", capacity: 1, startMin: 0, endMin: 60 },
    ];
    const svc = new EnrollmentService(":memory:", classes);
    svc.enroll("o1", "B"); // 占满
    const w = svc.enroll("s1", "B"); // 旧候补，无冲突、可晋级
    assert.equal(w.status, "waitlisted");

    // 并发：退课 + 新申请
    const ops =
      order === 0
        ? [() => svc.drop("o1", "B"), () => svc.enroll("s2", "B")]
        : [() => svc.enroll("s2", "B"), () => svc.drop("o1", "B")];
    await Promise.all(ops.map((op) => asyncCall(op)));

    // 无论串行顺序如何，空位必须归受理序号更早的 s1
    assert.deepEqual(
      svc.getStudentStatus("s1").enrolled.map((a) => a.classId),
      ["B"],
      `order ${order}`,
    );
    assert.equal(svc.getStudentStatus("s2").waitlisted.length, 1);
    svc.close();
  }
});

test("并发选退课期间任何查询都看不到回填中间状态", async () => {
  const rng = makeRng(777);
  const classes: ClassDef[] = [];
  for (let i = 0; i < 6; i += 1) {
    const start = Math.floor(rng() * 8) * 60;
    classes.push({
      classId: `C${i}`,
      capacity: 1 + Math.floor(rng() * 2),
      startMin: start,
      endMin: start + 120,
    });
  }
  const classIds = classes.map((c) => c.classId);
  const studentIds = Array.from({ length: 12 }, (_, i) => `S${i}`);
  const svc = new EnrollmentService(":memory:", classes);
  const ref = new ReferenceModel(classes);

  // 预热：制造一批候补
  for (let i = 0; i < 40; i += 1) {
    const s = studentIds[Math.floor(rng() * studentIds.length)];
    const c = classIds[Math.floor(rng() * classIds.length)];
    svc.enroll(s, c);
    ref.enroll(s, c);
  }

  // 并发阶段：混合选退课 + 查询；记录写操作实际完成顺序
  const completionLog: Array<() => void> = [];
  const tasks: Promise<unknown>[] = [];
  for (let i = 0; i < 100; i += 1) {
    const s = studentIds[Math.floor(rng() * studentIds.length)];
    const c = classIds[Math.floor(rng() * classIds.length)];
    const isEnroll = rng() < 0.5;
    const apply = () => (isEnroll ? ref.enroll(s, c) : ref.drop(s, c));
    tasks.push(
      asyncCall(
        () => (isEnroll ? svc.enroll(s, c) : svc.drop(s, c)),
        () => completionLog.push(apply),
      ),
    );
    if (i % 3 === 0) {
      const qc = classIds[Math.floor(rng() * classIds.length)];
      tasks.push(asyncCall(() => checkClassConsistency(svc, classes, qc)));
    }
  }
  await Promise.all(tasks);

  // 结果必须等价于按实际完成顺序的串行执行
  for (const apply of completionLog) apply();
  assert.deepEqual(dumpService(svc, classIds), ref.dump());
  assertInvariants(svc, classes, studentIds);
  svc.close();
});
