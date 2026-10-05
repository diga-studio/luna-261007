import assert from "node:assert/strict";
import { test } from "node:test";
import { EnrollmentService, type ClassDef } from "../src/index.js";

/**
 * 验收场景：学生退课后同时具备两个互相冲突班级的回填资格，
 * 只能进入受理序号较早的班级，另一条候补仍保留。
 */
test("退课后获得两个冲突班级的回填资格，只进序号较早者", () => {
  const classes: ClassDef[] = [
    { classId: "X", capacity: 1, startMin: 90, endMin: 200 }, // 挡住 P 和 Q
    { classId: "P", capacity: 1, startMin: 100, endMin: 160 },
    { classId: "Q", capacity: 1, startMin: 120, endMin: 180 }, // 与 P 冲突
  ];
  const svc = new EnrollmentService(":memory:", classes);
  svc.enroll("other1", "P");
  svc.enroll("other2", "Q");
  svc.enroll("s", "X");
  const p = svc.enroll("s", "P"); // P 满 → 候补
  const q = svc.enroll("s", "Q"); // Q 满 → 候补
  assert.equal(p.status, "waitlisted");
  assert.equal(q.status, "waitlisted");
  assert.ok(p.seq! < q.seq!);

  // P、Q 各腾出一个空位，但 s 已选 X 与二者冲突，仍不能晋级
  svc.drop("other1", "P");
  svc.drop("other2", "Q");
  assert.equal(svc.getStudentStatus("s").enrolled.length, 1);

  // s 退掉 X：撤销与全部回填在同一事务内完成。
  // P 的受理序号较早 → s 进 P；Q 与 P 冲突，候补保留且序号不变。
  svc.drop("s", "X");
  const st = svc.getStudentStatus("s");
  assert.deepEqual(
    st.enrolled.map((a) => a.classId),
    ["P"],
  );
  assert.deepEqual(
    st.waitlisted.map((a) => ({ classId: a.classId, seq: a.seq })),
    [{ classId: "Q", seq: q.seq }],
  );
  svc.close();
});

test("被跳过的候补保留原序号，后续空位仍按原序号竞争", () => {
  const classes: ClassDef[] = [
    { classId: "A", capacity: 1, startMin: 0, endMin: 100 },
    { classId: "B", capacity: 1, startMin: 50, endMin: 150 }, // 与 A 冲突
  ];
  const svc = new EnrollmentService(":memory:", classes);
  svc.enroll("o1", "B"); // B 满
  svc.enroll("s1", "A"); // s1 已选 A
  const w1 = svc.enroll("s1", "B"); // 候补 B，seq 较早
  const w2 = svc.enroll("s2", "B"); // 候补 B，seq 较晚
  // B 腾出空位：s1 因 A 冲突被跳过，s2 晋级
  svc.drop("o1", "B");
  assert.deepEqual(
    svc.getStudentStatus("s2").enrolled.map((a) => a.classId),
    ["B"],
  );
  // s1 的候补保留原序号
  assert.deepEqual(svc.getStudentStatus("s1").waitlisted[0].seq, w1.seq);
  assert.ok(w1.seq! < w2.seq!);
  // s1 退掉 A 后，下一个 B 空位应优先给 s1（序号更小）
  svc.drop("s1", "A");
  svc.drop("s2", "B");
  assert.deepEqual(
    svc.getStudentStatus("s1").enrolled.map((a) => a.classId),
    ["B"],
  );
  svc.close();
});
