import assert from "node:assert/strict";
import { test } from "node:test";
import { makeSystem } from "./helpers.js";

// X 与 P、Q 均冲突；P 与 Q 互相冲突。
const classes = [
  { classId: "X", capacity: 1, startMin: 0, endMin: 180 },
  { classId: "P", capacity: 1, startMin: 100, endMin: 150 },
  { classId: "Q", capacity: 1, startMin: 140, endMin: 200 },
];

test("退课后同时具备两个冲突班级的回填资格：只进序号较早者，另一条候补保留", () => {
  const { sys } = makeSystem("bf-two-conflict", classes);
  sys.enroll("s1", "X"); // seq1 已选，挡住 P、Q
  const wp = sys.enroll("s1", "P"); // seq2 候补（与 X 冲突）
  const wq = sys.enroll("s1", "Q"); // seq3 候补（与 X 冲突）
  assert.equal(wp.status, "waitlisted");
  assert.equal(wq.status, "waitlisted");

  sys.drop("s1", "X"); // 退课后同时具备 P、Q 资格
  const st = sys.getStudentState("s1");
  assert.deepEqual(
    st.enrolled.map((x) => [x.classId, x.seq]),
    [["P", 2]],
    "只能进入序号较早的 P",
  );
  assert.deepEqual(
    st.waitlisted.map((x) => [x.classId, x.seq]),
    [["Q", 3]],
    "Q 的候补仍保留原序号",
  );

  // 被跳过的候补不得取消：退掉 P 后应凭原序号晋级 Q
  sys.drop("s1", "P");
  const st2 = sys.getStudentState("s1");
  assert.deepEqual(
    st2.enrolled.map((x) => [x.classId, x.seq]),
    [["Q", 3]],
  );
  assert.equal(st2.waitlisted.length, 0);
  sys.close();
});

test("全局按受理序号回填：序号小的晋级造成的冲突会阻止同学生其他候补", () => {
  const { sys } = makeSystem("bf-global-order", classes);
  sys.enroll("s1", "X"); // seq1，挡住 P、Q
  sys.enroll("s1", "P"); // seq2 候补
  sys.enroll("s2", "Q"); // seq3：s2 无冲突且 Q 有空位 -> 直接已选
  assert.equal(sys.getStudentState("s2").enrolled.length, 1);
  sys.enroll("s1", "Q"); // seq4 候补（与 X 冲突，且 Q 此时已满）
  sys.drop("s2", "Q"); // Q 空出，但 s1 仍被 X 挡住，s1 不能进 Q
  assert.equal(sys.getStudentState("s1").waitlisted.length, 2);
  sys.drop("s1", "X"); // s1 同时具备 P、Q 资格，按序号进 P
  const st = sys.getStudentState("s1");
  assert.deepEqual(
    st.enrolled.map((x) => x.classId),
    ["P"],
  );
  assert.deepEqual(
    st.waitlisted.map((x) => [x.classId, x.seq]),
    [["Q", 4]],
  );
  sys.close();
});

