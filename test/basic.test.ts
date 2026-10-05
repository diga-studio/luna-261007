import assert from "node:assert/strict";
import { test } from "node:test";
import { EnrollmentSystem } from "../src/index.js";
import { makeSystem } from "./helpers.js";

const classes = [
  { classId: "A", capacity: 1, startMin: 0, endMin: 60 },
  { classId: "B", capacity: 1, startMin: 60, endMin: 120 }, // 与 A 首尾相接，不冲突
  { classId: "C", capacity: 1, startMin: 30, endMin: 90 }, // 与 A、B 均冲突
  { classId: "D", capacity: 2, startMin: 200, endMin: 260 },
];

test("有空位时选课直接成为已选", () => {
  const { sys } = makeSystem("basic-direct", classes);
  const r = sys.enroll("s1", "A");
  assert.equal(r.status, "enrolled");
  assert.equal(r.seq, 1);
  assert.deepEqual(
    sys.getStudentState("s1").enrolled.map((x) => x.classId),
    ["A"],
  );
  sys.close();
});

test("重复选同班幂等：不新增申请、不改变序号", () => {
  const { sys } = makeSystem("basic-idem", classes);
  const r1 = sys.enroll("s1", "A");
  const r2 = sys.enroll("s1", "A");
  assert.deepEqual(r2, r1);
  assert.equal(sys.getStudentState("s1").enrolled.length, 1);
  // 满班后再选仍幂等，且其他人进来只能候补
  const r3 = sys.enroll("s2", "A");
  assert.equal(r3.status, "waitlisted");
  assert.equal(r3.seq, 2);
  const r4 = sys.enroll("s2", "A");
  assert.deepEqual(r4, r3);
  assert.equal(sys.getClassState("A").waitlisted.length, 1);
  sys.close();
});

test("退课后重新申请取得新序号", () => {
  const { sys } = makeSystem("basic-reseq", classes);
  const r1 = sys.enroll("s1", "A");
  assert.equal(r1.seq, 1);
  sys.drop("s1", "A");
  const r2 = sys.enroll("s1", "A");
  assert.equal(r2.seq, 2);
  assert.equal(r2.status, "enrolled");
  sys.close();
});

test("退课可撤销候补；无有效申请时退课不改变状态", () => {
  const { sys } = makeSystem("basic-drop", classes);
  sys.enroll("s1", "A");
  const w = sys.enroll("s2", "A");
  assert.equal(w.status, "waitlisted");
  const d = sys.drop("s2", "A");
  assert.equal(d.status, null);
  assert.equal(d.seq, w.seq);
  assert.equal(sys.getStudentState("s2").waitlisted.length, 0);
  // 再次退课：无有效申请，返回 null，不影响他人
  const d2 = sys.drop("s2", "A");
  assert.deepEqual(d2, { status: null, seq: null });
  assert.equal(sys.getClassState("A").enrolled.length, 1);
  sys.close();
});

test("容量上限与候补顺序", () => {
  const { sys } = makeSystem("basic-cap", classes);
  sys.enroll("s1", "D");
  sys.enroll("s2", "D");
  const w1 = sys.enroll("s3", "D");
  const w2 = sys.enroll("s4", "D");
  assert.equal(w1.status, "waitlisted");
  assert.equal(w2.status, "waitlisted");
  // 退一个已选，序号最小的候补晋级
  sys.drop("s1", "D");
  assert.deepEqual(
    sys.getClassState("D").enrolled.map((x) => x.studentId),
    ["s2", "s3"],
  );
  assert.deepEqual(
    sys.getClassState("D").waitlisted.map((x) => x.studentId),
    ["s4"],
  );
  sys.close();
});

test("时间冲突：首尾相接不算冲突，重叠才冲突", () => {
  const { sys } = makeSystem("basic-conflict", classes);
  sys.enroll("s1", "A");
  const b = sys.enroll("s1", "B"); // 60-120 与 0-60 相接，可同选
  assert.equal(b.status, "enrolled");
  const c = sys.enroll("s1", "C"); // 30-90 与 A、B 均冲突，只能候补
  assert.equal(c.status, "waitlisted");
  sys.close();
});

test("非法班级配置与未知班级报错", () => {
  assert.throws(
    () => EnrollmentSystem.create(":memory:", [
      { classId: "X", capacity: 31, startMin: 0, endMin: 10 },
    ]),
    /capacity/,
  );
  assert.throws(
    () => EnrollmentSystem.create(":memory:", [
      { classId: "X", capacity: 1, startMin: 10, endMin: 10 },
    ]),
    /time range/,
  );
  const { sys } = makeSystem("basic-unknown", classes);
  assert.throws(() => sys.enroll("s1", "ZZZ"), /unknown classId/);
  assert.throws(() => sys.drop("s1", "ZZZ"), /unknown classId/);
  assert.throws(() => sys.getClassState("ZZZ"), /unknown classId/);
  sys.close();
});
