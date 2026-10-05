// 上限规模实测：4 模板 × 48 片段 × 3 选项 × 最多 4 码点，提交 128 码点。
// 断言：装入 ≤ 5s，单次判定 ≤ 5s，进程峰值内存 ≤ 256 MiB。
import { AnswerMatcher } from "../dist/index.js";

const MiB = 1024 * 1024;
const LOAD_BUDGET_MS = 5000;
const JUDGE_BUDGET_MS = 5000;
const MEMORY_BUDGET_MIB = 256;

let rngState = 26100733;
const rng = () => {
  rngState = (rngState * 1664525 + 1013904223) >>> 0;
  return rngState / 0x100000000;
};

// 选项长度在 1..4 间变化，使每个状态的可达长度集合尽量大（最坏情形）。
function makeTemplates() {
  const templates = [];
  for (let t = 0; t < 4; t += 1) {
    const segments = [];
    for (let s = 0; s < 48; s += 1) {
      const options = [];
      for (let o = 0; o < 3; o += 1) {
        const len = 1 + ((s + o + t) % 4);
        let option = "";
        for (let k = 0; k < len; k += 1) {
          option += String.fromCodePoint(0x41 + ((t * 7 + s * 3 + o * 11 + k * 5) % 26));
        }
        options.push(option);
      }
      segments.push(options);
    }
    templates.push({ segments });
  }
  return templates;
}

function makeSubmission() {
  let text = "";
  for (let i = 0; i < 128; i += 1) {
    text += String.fromCodePoint(0x41 + Math.floor(rng() * 26));
  }
  return text;
}

const baselineRss = process.memoryUsage().rss;

const loadStart = performance.now();
const matcher = new AnswerMatcher(makeTemplates());
const loadMs = performance.now() - loadStart;

const judgeTimes = [];
let lastResult = null;
for (let i = 0; i < 5; i += 1) {
  const submission = makeSubmission();
  const start = performance.now();
  lastResult = matcher.judge(submission);
  judgeTimes.push(performance.now() - start);
}

// 连续判定的确定性：同一提交两次结果一致。
const probe = makeSubmission();
const first = matcher.judge(probe);
const second = matcher.judge(probe);

const peakRss = process.memoryUsage().rss;
const maxJudgeMs = Math.max(...judgeTimes);

console.log("=== 上限规模实测 ===");
console.log("模板规模: 4 模板 × 48 片段 × 3 选项 × ≤4 码点");
console.log(`装入耗时: ${loadMs.toFixed(1)} ms (上限 ${LOAD_BUDGET_MS} ms)`);
console.log(
  `判定耗时: ${judgeTimes.map((t) => t.toFixed(1)).join(", ")} ms (单次上限 ${JUDGE_BUDGET_MS} ms)`,
);
console.log(
  `进程内存: 基线 ${(baselineRss / MiB).toFixed(1)} MiB → 峰值 ${(peakRss / MiB).toFixed(1)} MiB (上限 ${MEMORY_BUDGET_MIB} MiB)`,
);
console.log(
  `样例结果: score=${lastResult.score.toFixed(4)} passed=${lastResult.passed} answer=${JSON.stringify(lastResult.answer.slice(0, 40))}...`,
);

const failures = [];
if (loadMs > LOAD_BUDGET_MS) failures.push("装入超时");
if (maxJudgeMs > JUDGE_BUDGET_MS) failures.push("判定超时");
if (peakRss > MEMORY_BUDGET_MIB * MiB) failures.push("内存超限");
if (first.score !== second.score || first.answer !== second.answer) {
  failures.push("连续判定结果不一致");
}
if (!(lastResult.score >= 0 && lastResult.score <= 1)) {
  failures.push("分数越界");
}

if (failures.length > 0) {
  console.error(`未通过: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("性能与内存全部达标");
