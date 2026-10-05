import assert from "node:assert/strict";
import { test } from "node:test";
import { EnrollmentService, type ClassDef } from "../src/index.js";

const CLASSES: ClassDef[] = [
  { classId: "A", capacity: 1, startMin: 0, endMin: 60 },
  { classId: "B", capacity: 2, startMin: 30, endMin: 90 },
  { classId: "C", capacity: 1, startMin: 60, endMin: 120 },
];

function makeService(): EnrollmentService {
  return new EnrollmentService(":memory:", CLASSES);
}

test("有空位时新申请经回填直接成为已选", () => {
  const svc = makeService();
  const r = svc.enroll("s1", "A");
  assert.equal(r.status, "enrolled");
  assert.equal(r.seq, 1);
  svc.close();
});

test("满班时新申请进入候补，受理序号递增", () => {
  const svc = makeService();
  svc.enroll("s1", "A");
  const r2 = svc.enroll("s2", "A");
  const r3 = svc.enroll("s3", "A");
  assert.equal(r2.status, "waitlisted");
  assert.equal(r3.status, "waitlisted");
  assert.ok(r2.seq! < r3.seq!);
  svc.close();
});

test("重复选同班不新增申请也不改变序号", () => {
  const svc = makeService();
  svc.enroll("s1", "A");
  const first = svc.enroll("s2", "A");
  svc.enroll("s3", "A");
  const again = svc.enroll("s2", "A");
  assert.equal(again.seq, first.seq);
  assert.equal(again.status, "waitlisted");
  assert.equal(svc.getClassStatus("A").waitlisted.length, 2);
  svc.close();
});

test("退课后重新申请取得新序号", () => {
  const svc = makeService();
  svc.enroll("s1", "A");
  const first = svc.enroll("s2", "A");
  svc.drop("s2", "A");
  const second = svc.enroll("s2", "A");
  assert.ok(second.seq! > first.seq!);
  svc.close();
});

test("退课可撤销候补，无有效申请时退课不改变状态", () => {
  const svc = makeService();
  svc.enroll("s1", "A");
  svc.enroll("s2", "A");
  const r = svc.drop("s2", "A");
  assert.equal(r.status, null);
  assert.equal(svc.getStudentStatus("s2").waitlisted.length, 0);
  const noop = svc.drop("s2", "A");
  assert.deepEqual(noop, { status: null, seq: null });
  const noop2 = svc.drop("nobody", "A");
  assert.deepEqual(noop2, { status: null, seq: null });
  svc.close();
});

test("满班退课后按受理序号回填", () => {
  const svc = makeService();
  svc.enroll("s1", "A");
  svc.enroll("s2", "A");
  svc.enroll("s3", "A");
  svc.drop("s1", "A");
  const st = svc.getClassStatus("A");
  assert.deepEqual(
    st.enrolled.map((a) => a.studentId),
    ["s2"],
  );
  assert.deepEqual(
    st.waitlisted.map((a) => a.studentId),
    ["s3"],
  );
  svc.close();
});

test("首尾相接不算冲突", () => {
  const svc = makeService();
  const r1 = svc.enroll("s1", "A"); // 0-60
  const r2 = svc.enroll("s1", "C"); // 60-120
  assert.equal(r1.status, "enrolled");
  assert.equal(r2.status, "enrolled");
  svc.close();
});

test("时间冲突的班级不会被自动录取", () => {
  const svc = makeService();
  svc.enroll("s1", "A"); // 0-60
  svc.enroll("s2", "B"); // 30-90，B 容量 2
  // B 尚有一个空位，但 s1 已选 A 与 B 冲突，s1 申請 B 只能候补
  const r = svc.enroll("s1", "B");
  assert.equal(r.status, "waitlisted");
  svc.close();
});

test("未知班级报错", () => {
  const svc = makeService();
  assert.throws(() => svc.enroll("s1", "ZZZ"), /unknown class/);
  assert.throws(() => svc.getClassStatus("ZZZ"), /unknown class/);
  svc.close();
});

test("容量上限 30 在初始化时校验", () => {
  assert.throws(
    () =>
      new EnrollmentService(":memory:", [
        { classId: "X", capacity: 31, startMin: 0, endMin: 60 },
      ]),
    /capacity/,
  );
});
