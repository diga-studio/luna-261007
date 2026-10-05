import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { EnrollmentSystem } from "../src/index.js";
import { freshDbPath, makeRng } from "./helpers.js";

const CLASS_COUNT = 20_000;
const STUDENT_COUNT = 100_000;
const WAITLIST_TOTAL = 500_000;
const CAPACITY = 30;
const DAY_MIN = 1440;
const CLASS_LEN = 60;

/** 每班候补数：20/25/30/35 混合，总数恰为 50 万。 */
function waitlistSize(i: number): number {
  return (20 + (i % 2 ? 5 : 0) + (i % 4 === 0 ? 5 : 0) + (i % 8 === 0 ? 5 : 0) + (i % 16 === 0 ? 10 : 0));
}

interface GenClass {
  classId: string;
  startMin: number;
  endMin: number;
  enrolled: number[]; // student indexes
  waitlisted: number[];
}

function generate(dbPath: string): GenClass[] {
  const rng = makeRng(20261007);
  const intervals: Array<Array<[number, number]>> = Array.from(
    { length: STUDENT_COUNT },
    () => [],
  );
  const classes: GenClass[] = [];
  let classIndex = 0;
  let guard = 0;
  while (classes.length < CLASS_COUNT && guard++ < CLASS_COUNT * 3) {
    const startMin = Math.floor(rng() * (DAY_MIN - CLASS_LEN));
    const endMin = startMin + CLASS_LEN;
    const enrolled: number[] = [];
    const inClass = new Set<number>();
    let attempts = 0;
    while (enrolled.length < CAPACITY && attempts++ < 500) {
      const s = Math.floor(rng() * STUDENT_COUNT);
      if (inClass.has(s)) continue;
      const iv = intervals[s]!;
      if (iv.some(([a, b]) => a < endMin && startMin < b)) continue;
      inClass.add(s);
      enrolled.push(s);
      iv.push([startMin, endMin]);
    }
    if (enrolled.length < CAPACITY) continue; // 装不满的班舍弃，另生成
    const waitlisted: number[] = [];
    const want = waitlistSize(classIndex);
    attempts = 0;
    while (waitlisted.length < want && attempts++ < want * 20) {
      const s = Math.floor(rng() * STUDENT_COUNT);
      if (inClass.has(s)) continue;
      inClass.add(s);
      waitlisted.push(s);
    }
    if (waitlisted.length < want) {
      // 候补不足则放弃该班（回滚已占时段，避免数据不一致）
      for (const s of enrolled) {
        const iv = intervals[s]!;
        iv.splice(iv.findIndex(([a]) => a === startMin), 1);
      }
      continue;
    }
    classes.push({
      classId: `K${classIndex}`,
      startMin,
      endMin,
      enrolled,
      waitlisted,
    });
    classIndex++;
  }
  assert.equal(classes.length, CLASS_COUNT, "班级生成不足");

  const totalWait = classes.reduce((n, c) => n + c.waitlisted.length, 0);
  assert.equal(totalWait, WAITLIST_TOTAL, "候补总数不符");

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = OFF");
  db.exec(`
    CREATE TABLE classes (
      class_id TEXT PRIMARY KEY,
      capacity INTEGER NOT NULL CHECK (capacity BETWEEN 1 AND 30),
      start_min INTEGER NOT NULL,
      end_min INTEGER NOT NULL CHECK (end_min > start_min)
    );
    CREATE TABLE requests (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT NOT NULL,
      class_id TEXT NOT NULL REFERENCES classes(class_id),
      status TEXT NOT NULL CHECK (status IN ('enrolled', 'waitlisted'))
    );
    CREATE INDEX idx_requests_student ON requests(student_id);
    CREATE INDEX idx_requests_class ON requests(class_id);
  `);
  const insClass = db.prepare(
    "INSERT INTO classes (class_id, capacity, start_min, end_min) VALUES (?, ?, ?, ?)",
  );
  const insReq = db.prepare(
    "INSERT INTO requests (student_id, class_id, status) VALUES (?, ?, ?)",
  );
  db.exec("BEGIN");
  for (const c of classes) insClass.run(c.classId, CAPACITY, c.startMin, c.endMin);
  db.exec("COMMIT");
  db.exec("BEGIN");
  for (const c of classes) {
    for (const s of c.enrolled) insReq.run(`S${s}`, c.classId, "enrolled");
  }
  db.exec("COMMIT");
  db.exec("BEGIN");
  for (const c of classes) {
    for (const s of c.waitlisted) insReq.run(`S${s}`, c.classId, "waitlisted");
  }
  db.exec("COMMIT");
  db.close();
  return classes;
}

test("规模验证：2万班级/10万学生/50万候补下的并发选退课与查询耗时", { timeout: 300_000 }, () => {
  const dbPath = freshDbPath("perf");
  const t0 = performance.now();
  const classes = generate(dbPath);
  const tGen = performance.now() - t0;

  const t1 = performance.now();
  const sys = EnrollmentSystem.open(dbPath);
  const tLoad = performance.now() - t1;

  // 统计每个学生的候补数量，用于挑选“资格变化 ≤20”的退课对象
  const waitCount = new Map<number, number>();
  for (const c of classes) {
    for (const s of c.waitlisted) waitCount.set(s, (waitCount.get(s) ?? 0) + 1);
  }

  // 50 个退课：选自候补恰为 20 的班、且本人无其他候补的已选学生
  const dropPairs: Array<{ student: string; classId: string }> = [];
  for (const c of classes) {
    if (dropPairs.length >= 50) break;
    if (c.waitlisted.length !== 20) continue;
    const s = c.enrolled.find((x) => (waitCount.get(x) ?? 0) === 0);
    if (s !== undefined) dropPairs.push({ student: `S${s}`, classId: c.classId });
  }
  assert.equal(dropPairs.length, 50, "退课样本不足");

  // 50 个新申请：随机学生选随机班（确保该班无其有效申请）
  const rng = makeRng(7);
  const enrollPairs: Array<{ student: string; classId: string }> = [];
  while (enrollPairs.length < 50) {
    const s = Math.floor(rng() * STUDENT_COUNT);
    const c = classes[Math.floor(rng() * classes.length)]!;
    if (c.enrolled.includes(s) || c.waitlisted.includes(s)) continue;
    enrollPairs.push({ student: `S${s}`, classId: c.classId });
  }

  // 100 个并发请求（50 退课 + 50 选课），async 包装模拟并发到达；
  // 库方法为同步执行，天然按完成先后串行化。
  const tasks = [
    ...dropPairs.map((p) => async () => {
      await new Promise<void>((r) => setImmediate(r));
      sys.drop(p.student, p.classId);
    }),
    ...enrollPairs.map((p) => async () => {
      await new Promise<void>((r) => setImmediate(r));
      sys.enroll(p.student, p.classId);
    }),
  ];
  const startOps = performance.now();
  return Promise.all(tasks.map((t) => t())).then(() => {
    const opsMs = performance.now() - startOps;
    assert.ok(opsMs < 2000, `100 个并发选退课耗时 ${opsMs.toFixed(1)}ms，超过 2s`);

    // 学生状态查询 p95
    const samples: number[] = [];
    for (let i = 0; i < 2000; i++) {
      const s = `S${Math.floor(rng() * STUDENT_COUNT)}`;
      const a = performance.now();
      sys.getStudentState(s);
      samples.push(performance.now() - a);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)]!;
    assert.ok(p95 < 100, `学生状态查询 p95=${p95.toFixed(2)}ms，超过 100ms`);

    console.log(
      `  [perf] 数据生成 ${tGen.toFixed(0)}ms, 载入 ${tLoad.toFixed(0)}ms, ` +
        `100并发选退课 ${opsMs.toFixed(1)}ms, 查询p95 ${p95.toFixed(3)}ms`,
    );
    sys.close();
  });
});
