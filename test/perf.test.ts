import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { editDistance } from "../src/index.js";
import type { AnswerTemplate, JudgeResult } from "../src/types.js";
import { isLegalAnswer } from "./helpers.js";

interface PerfJudge extends JudgeResult {
  readonly name: string;
  readonly learner: string;
  readonly ms: number;
}

interface PerfReport {
  readonly loadMs: number;
  readonly judges: readonly PerfJudge[];
  readonly maxRssBytes: number;
  readonly templates: AnswerTemplate[];
}

const MIB = 1024 * 1024;

test("上限规模：精确结果、耗时与内存达标、连续判定互不影响", { timeout: 120000 }, () => {
  // 本文件编译后位于 dist/test/，项目根在上两级。
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const stdout = execFileSync(process.execPath, ["test/fixtures/perf-child.mjs"], {
    cwd: projectRoot,
    maxBuffer: 64 * MIB,
    encoding: "utf8",
  });
  const report: PerfReport = JSON.parse(stdout);

  console.log(
    `    [perf] load=${report.loadMs.toFixed(1)}ms ` +
      `judges=[${report.judges.map((j) => `${j.name}:${j.ms.toFixed(1)}ms`).join(", ")}] ` +
      `peakRss=${(report.maxRssBytes / MIB).toFixed(1)}MiB`,
  );

  // 资源上限：装入 < 5s，单次判定 < 5s，峰值内存 < 256 MiB。
  assert.ok(report.loadMs < 5000, `load too slow: ${report.loadMs}ms`);
  for (const j of report.judges) {
    assert.ok(j.ms < 5000, `judge ${j.name} too slow: ${j.ms}ms`);
  }
  assert.ok(
    report.maxRssBytes < 256 * MIB,
    `peak rss too high: ${(report.maxRssBytes / MIB).toFixed(1)}MiB`,
  );

  // 精确性：学习者回答本身就是一条 128 码点的合法回答时，必须得到相似度 1。
  const exact = report.judges.find((j) => j.name === "exact")!;
  assert.equal(exact.similarity, 1);
  assert.equal(exact.passed, true);
  assert.equal(exact.answer, exact.learner);

  // 连续判定互不影响：同一回答前后两次判定结果完全一致。
  const again = report.judges.find((j) => j.name === "exactAgain")!;
  assert.deepEqual(
    { similarity: again.similarity, passed: again.passed, answer: again.answer },
    { similarity: exact.similarity, passed: exact.passed, answer: exact.answer },
  );

  // 每次判定：返回句合法，且其自身相似度与报告分数一致。
  for (const j of report.judges) {
    assert.ok(
      report.templates.some((t) => isLegalAnswer(t, j.answer)),
      `${j.name}: returned answer is not legal`,
    );
    const len = Array.from(j.answer).length;
    const n = Array.from(j.learner).length;
    const den = Math.max(len, n);
    const own = den === 0 ? 1 : (den - editDistance(j.answer, j.learner)) / den;
    assert.equal(own, j.similarity, `${j.name}: answer does not achieve reported score`);
    assert.equal(j.passed, j.similarity >= 0.8, `${j.name}: passed flag inconsistent`);
  }

  // 空句约定：合法回答含空串以外、长度至少 0 的串；此处模板可生成空串，空句应得 1。
  const empty = report.judges.find((j) => j.name === "empty")!;
  assert.equal(empty.similarity, 1);
  assert.equal(empty.answer, "");
});
