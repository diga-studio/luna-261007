import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnrollmentService, type ClassDef } from "../src/index.js";
import { makeRng } from "./helpers.js";

const CLASS_COUNT = 20_000;
const STUDENT_COUNT = 100_000;
const APPS_PER_STUDENT = 12; // 共 120 万申请，回填后候补 ≥ 50 万
const REQUEST_COUNT = 100;
const QUERY_COUNT = 1_000;

test(
  "性能：2万班级/10万学生/50万候补下，100 并发选退课 < 2s，学生查询 p95 < 100ms",
  { timeout: 600_000 },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "enroll-perf-"));
    const dbPath = join(dir, "round.db");
    const rng = makeRng(20261007);
    try {
      // ---- 生成班级：容量 30，一周内随机 60 分钟时段 ----
      const classes: ClassDef[] = [];
      for (let i = 0; i < CLASS_COUNT; i += 1) {
        const start = Math.floor(rng() * (7 * 24 * 60 - 60));
        classes.push({
          classId: `K${i}`,
          capacity: 30,
          startMin: start,
          endMin: start + 60,
        });
      }
      const svc = new EnrollmentService(dbPath, classes);

      // ---- 载入数据：每学生 12 个互不相同的班级 ----
      const entries: { studentId: string; classId: string }[] = [];
      for (let s = 0; s < STUDENT_COUNT; s += 1) {
        const picked = new Set<number>();
        while (picked.size < APPS_PER_STUDENT) {
          picked.add(Math.floor(rng() * CLASS_COUNT));
        }
        for (const c of picked) {
          entries.push({ studentId: `U${s}`, classId: `K${c}` });
        }
      }
      const loadStart = performance.now();
      svc.bulkLoad(entries);
      const loadMs = performance.now() - loadStart;

      const countRow = svcStats(svc);
      console.log(
        `  [perf] load ${entries.length} apps in ${loadMs.toFixed(0)}ms; ` +
          `enrolled=${countRow.enrolled} waitlisted=${countRow.waitlisted}`,
      );
      assert.ok(
        countRow.waitlisted >= 500_000,
        `expected >=500k waitlisted, got ${countRow.waitlisted}`,
      );

      // ---- 构造 100 个并发请求：50 退已选 + 50 新申请 ----
      const enrolledPairs: { studentId: string; classId: string }[] = [];
      while (enrolledPairs.length < REQUEST_COUNT / 2) {
        const c = `K${Math.floor(rng() * CLASS_COUNT)}`;
        const st = svc.getClassStatus(c);
        for (const app of st.enrolled) {
          if (enrolledPairs.length < REQUEST_COUNT / 2) {
            enrolledPairs.push({ studentId: app.studentId, classId: c });
          }
        }
      }
      type Req = () => void;
      const requests: Req[] = enrolledPairs.map(
        (p) => () => svc.drop(p.studentId, p.classId),
      );
      for (let i = 0; i < REQUEST_COUNT / 2; i += 1) {
        const s = `U${Math.floor(rng() * STUDENT_COUNT)}`;
        const c = `K${Math.floor(rng() * CLASS_COUNT)}`;
        requests.push(() => svc.enroll(s, c));
      }
      // 打乱顺序
      for (let i = requests.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rng() * (i + 1));
        [requests[i], requests[j]] = [requests[j], requests[i]];
      }

      const reqStart = performance.now();
      for (const req of requests) req();
      const reqMs = performance.now() - reqStart;
      console.log(
        `  [perf] ${REQUEST_COUNT} enroll/drop requests in ${reqMs.toFixed(1)}ms`,
      );
      assert.ok(reqMs < 2_000, `requests took ${reqMs.toFixed(1)}ms >= 2s`);

      // ---- 学生状态查询 p95 ----
      const durations: number[] = [];
      for (let i = 0; i < QUERY_COUNT; i += 1) {
        const s = `U${Math.floor(rng() * STUDENT_COUNT)}`;
        const t0 = performance.now();
        svc.getStudentStatus(s);
        durations.push(performance.now() - t0);
      }
      durations.sort((a, b) => a - b);
      const p95 = durations[Math.floor(QUERY_COUNT * 0.95)];
      console.log(`  [perf] student query p95 = ${p95.toFixed(3)}ms`);
      assert.ok(p95 < 100, `p95 ${p95.toFixed(3)}ms >= 100ms`);

      // ---- 抽样不变量检查 ----
      const byId = new Map(classes.map((c) => [c.classId, c]));
      for (let i = 0; i < 200; i += 1) {
        const s = `U${Math.floor(rng() * STUDENT_COUNT)}`;
        const st = svc.getStudentStatus(s);
        const times = st.enrolled.map((a) => byId.get(a.classId)!);
        for (let x = 0; x < times.length; x += 1) {
          for (let y = x + 1; y < times.length; y += 1) {
            assert.ok(
              times[x].startMin >= times[y].endMin ||
                times[y].startMin >= times[x].endMin,
              `student ${s} has conflicting enrollments`,
            );
          }
        }
      }
      svc.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

function svcStats(svc: EnrollmentService): { enrolled: number; waitlisted: number } {
  return svc.stats();
}
