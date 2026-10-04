// 上限规模性能测量子进程：4 模板 × 48 片段 × 3 不同选项（长度 0/4/4，含补充平面字符）。
// 输出 JSON：装入耗时、各次判定耗时与结果、进程峰值 RSS。
import { AnswerMatcher } from "../../dist/src/index.js";

let maxRss = process.memoryUsage().rss;
const sampler = setInterval(() => {
  const rss = process.memoryUsage().rss;
  if (rss > maxRss) maxRss = rss;
}, 5);

const templates = [];
for (let t = 0; t < 4; t++) {
  const template = [];
  for (let i = 0; i < 48; i++) {
    const a = String.fromCodePoint(0x1f600 + t * 64 + i);
    const b = String.fromCodePoint(0x20000 + t * 64 + i);
    template.push(["", a.repeat(4), a.repeat(3) + b]);
  }
  templates.push(template);
}

const t0 = performance.now();
const matcher = new AnswerMatcher(templates);
const loadMs = performance.now() - t0;

// 合法回答：模板0的前32段各选第3项，后16段选空，长度恰好 128 码点。
let exactLearner = "";
for (let i = 0; i < 32; i++) {
  exactLearner += String.fromCodePoint(0x1f600 + i).repeat(3) + String.fromCodePoint(0x20000 + i);
}
// 128 码点的无关回答。
const noiseLearner = "z9,👍".repeat(32);

const cases = [
  ["exact", exactLearner],
  ["noise128", noiseLearner],
  ["empty", ""],
  ["short", "abc"],
  ["exactAgain", exactLearner],
];

const judges = [];
for (const [name, learner] of cases) {
  const start = performance.now();
  const result = matcher.judge(learner);
  judges.push({ name, learner, ms: performance.now() - start, ...result });
}

clearInterval(sampler);
const finalRss = process.memoryUsage().rss;
if (finalRss > maxRss) maxRss = finalRss;

console.log(JSON.stringify({ loadMs, judges, maxRssBytes: maxRss, templates }));
