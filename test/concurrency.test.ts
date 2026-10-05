import assert from "node:assert/strict";
import { test } from "node:test";
import { EnrollmentSystem } from "../src/index.js";
import { makeRng, makeSystem, ReferenceModel, type Op } from "./helpers.js";

const yieldTurn = () => new Promise<void>((r) => setImmediate(r));

test("满班退课与新申请并发：新申请不能越过可晋级的旧候补", async () => {
  const classes = [
    { classId: "F", capacity: 1, startMin: 0, endMin: 60 },
    { classId: "G", capacity: 1, startMin: 300, endMin: 360 },
  ];
  // 两种交错顺序各跑一次：退课先完成 / 新申请先完成
  for (const dropFirst of [true, false]) {
    const { sys } = makeSystem(`conc-overtake-${dropFirst}`, classes);
    sys.enroll("holder", "F"); // 占满 F
    const oldWaiter = sys.enroll("old", "F"); // 旧候补
    assert.equal(oldWaiter.status, "waitlisted");

    const doDrop = async () => {
      await yieldTurn();
      sys.drop("holder", "F");
    };
    const doEnroll = async () => {
      await yieldTurn();
      sys.enroll("new", "F");
    };
    await Promise.all(dropFirst ? [doDrop(), doEnroll()] : [doEnroll(), doDrop()]);

    const f = sys.getClassState("F");
    assert.deepEqual(
      f.enrolled.map((x) => x.studentId),
      ["old"],
      "空位必须给可晋级的旧候补",
    );
    assert.deepEqual(
      f.waitlisted.map((x) => x.studentId),
      ["new"],
      "新申请只能排在后面候补",
    );
    sys.close();
  }
});

test("并发混合选退课：查询看不到中间状态，结果等价于串行执行", async () => {
  const rng = makeRng(42);
  const classes = Array.from({ length: 6 }, (_, i) => ({
    classId: `C${i}`,
    capacity: 1 + (i % 3),
    startMin: (i % 4) * 45,
    endMin: (i % 4) * 45 + 90,
  }));
  const classIds = classes.map((c) => c.classId);
  const students = Array.from({ length: 12 }, (_, i) => `s${i}`);
  const { sys, dbPath } = makeSystem("conc-burst", classes);

  // 记录全部操作的实际执行顺序（预热 + 并发段）
  const executed: Op[] = [];
  const run = (op: Op) => {
    if (op.kind === "enroll") sys.enroll(op.studentId, op.classId);
    else sys.drop(op.studentId, op.classId);
    executed.push(op);
  };

  // 预热：制造一批已选与候补
  for (const s of students) {
    for (const c of classes) {
      if (rng() < 0.4) run({ kind: "enroll", studentId: s, classId: c.classId });
    }
  }

  // 不变量检查器：在操作间隙的每个宏任务里校验可见状态，
  // 任何时刻都不得看到“退课已生效但回填未完成”等中间状态。
  let stop = false;
  const watcher = (async () => {
    while (!stop) {
      await yieldTurn();
      for (const classId of classIds) {
        const cs = sys.getClassState(classId);
        assert.ok(cs.enrolled.length <= cs.capacity, `班级 ${classId} 超容量`);
      }
      for (const s of students) {
        const st = sys.getStudentState(s);
        const enrolled = st.enrolled.map(
          (x) => classes.find((k) => k.classId === x.classId)!,
        );
        for (let i = 0; i < enrolled.length; i++) {
          for (let j = i + 1; j < enrolled.length; j++) {
            const a = enrolled[i]!;
            const b = enrolled[j]!;
            assert.ok(
              a.startMin >= b.endMin || b.startMin >= a.endMin,
              `学生 ${s} 已选时间冲突`,
            );
          }
        }
        // 不存在“班级有空位且该学生无冲突”的候补
        for (const w of st.waitlisted) {
          const c = classes.find((k) => k.classId === w.classId)!;
          const cs = sys.getClassState(w.classId);
          if (cs.enrolled.length >= cs.capacity) continue;
          const conflicts = enrolled.some(
            (oc) => c.startMin < oc.endMin && oc.startMin < c.endMin,
          );
          assert.ok(conflicts, `存在空位且可晋级的候补 seq=${w.seq}`);
        }
      }
    }
  })();

  // 100 个并发选退课请求
  const tasks = Array.from({ length: 100 }, async () => {
    await yieldTurn();
    run({
      kind: rng() < 0.5 ? "enroll" : "drop",
      studentId: students[Math.floor(rng() * students.length)]!,
      classId: classIds[Math.floor(rng() * classIds.length)]!,
    });
  });
  await Promise.all(tasks);
  stop = true;
  await watcher;

  // 等价性：按实际完成顺序在参考实现中串行重放，终态必须一致
  const ref = new ReferenceModel(classes);
  for (const op of executed) ref.apply(op);
  for (const s of students) {
    assert.deepEqual(sys.getStudentState(s), ref.studentState(s), `student ${s}`);
  }
  for (const c of classIds) {
    assert.deepEqual(sys.getClassState(c), ref.classState(c), `class ${c}`);
  }
  sys.close();

  // 持久化：重新打开库，状态必须与内存终态一致
  const reopened = EnrollmentSystem.open(dbPath);
  for (const s of students) {
    assert.deepEqual(reopened.getStudentState(s), ref.studentState(s));
  }
  for (const c of classIds) {
    assert.deepEqual(reopened.getClassState(c), ref.classState(c));
  }
  // 重开后序号继续递增，不复用
  const r = reopened.enroll("brand-new", classIds[0]!);
  const maxSeq = Math.max(0, ...executed.length ? [refSeqMax(ref, students, classIds)] : [0]);
  assert.ok(r.seq !== null && r.seq > maxSeq, "受理序号必须继续递增");
  reopened.close();
});

/** 参考实现中当前最大受理序号。 */
function refSeqMax(ref: ReferenceModel, students: string[], classIds: string[]): number {
  let max = 0;
  for (const s of students) {
    for (const x of ref.studentState(s).enrolled) max = Math.max(max, x.seq);
    for (const x of ref.studentState(s).waitlisted) max = Math.max(max, x.seq);
  }
  void classIds;
  return max;
}
