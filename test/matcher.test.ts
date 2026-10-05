import { test } from "node:test";
import assert from "node:assert/strict";
import { AnswerMatcher, type AnswerTemplate } from "../dist/index.js";

// ---------- 测试辅助 ----------

function cps(text: string): number[] {
  return Array.from(text, (ch) => ch.codePointAt(0)!);
}

/** 码点级编辑距离（暴力 DP，用于对照）。 */
function lev(a: readonly number[], b: readonly number[]): number {
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      curr[j] = Math.min(
        prev[j]! + 1,
        curr[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

/** 枚举一个模板表达的全部合法回答。 */
function enumerate(template: AnswerTemplate): string[] {
  let acc = [""];
  for (const segment of template.segments) {
    const next: string[] = [];
    for (const prefix of acc) {
      for (const option of segment) {
        next.push(prefix + option);
      }
    }
    acc = next;
  }
  return acc;
}

/** 暴力法：全体合法回答中的最高相似度。 */
function bruteScore(templates: readonly AnswerTemplate[], submission: string): number {
  const target = cps(submission);
  let best = -1;
  for (const template of templates) {
    for (const answer of enumerate(template)) {
      const len = cps(answer).length;
      const L = Math.max(len, target.length);
      const sim = L === 0 ? 1 : (L - lev(cps(answer), target)) / L;
      if (sim > best) best = sim;
    }
  }
  return best;
}

/** 可复现的伪随机数。 */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

// ---------- 小规模场景 ----------

test("空选项参与拼接，精确匹配得满分", () => {
  const matcher = new AnswerMatcher([
    { segments: [["早", "早上"], ["好", ""], ["呀", ""]] },
  ]);
  assert.deepEqual(matcher.judge("早上好呀"), {
    score: 1,
    passed: true,
    answer: "早上好呀",
  });
  assert.deepEqual(matcher.judge("早好"), {
    score: 1,
    passed: true,
    answer: "早好",
  });
});

test("编辑可以跨越片段边界", () => {
  const template: AnswerTemplate = { segments: [["ab", "x"], ["cd", "y"]] };
  const legal = enumerate(template);
  const matcher = new AnswerMatcher([template]);
  // "acd" 与 "abcd" 的编辑距离为 1（删除 b），跨越了两个片段的拼接点。
  const result = matcher.judge("acd");
  assert.equal(result.score, 0.75);
  assert.equal(result.passed, false);
  assert.ok(legal.includes(result.answer));
  assert.equal(lev(cps(result.answer), cps("acd")), 1);
});

test("补充平面字符按单个码点处理", () => {
  const template: AnswerTemplate = { segments: [["😀", "😄"], ["好", ""]] };
  const matcher = new AnswerMatcher([template]);
  // "😀" 是 2 个 UTF-16 代码单元、1 个码点；若按代码单元比较则无法精确匹配。
  assert.deepEqual(matcher.judge("😀好"), { score: 1, passed: true, answer: "😀好" });
  assert.deepEqual(matcher.judge("😀"), { score: 1, passed: true, answer: "😀" });
  const result = matcher.judge("😀👋");
  assert.equal(result.score, 0.5);
  assert.equal(result.passed, false);
  assert.equal(result.answer, "😀");
});

test("空句按约定计分", () => {
  // 模板能产出空句，空提交得满分。
  const emptyAble = new AnswerMatcher([{ segments: [["", "x"]] }]);
  assert.deepEqual(emptyAble.judge(""), { score: 1, passed: true, answer: "" });
  // 模板只能产出非空句，空提交得 0 分，仍返回一条最优合法回答。
  const nonEmpty = new AnswerMatcher([{ segments: [["abc"]] }]);
  assert.deepEqual(nonEmpty.judge(""), { score: 0, passed: false, answer: "abc" });
  // 零片段模板只表达空句。
  const emptyOnly = new AnswerMatcher([{ segments: [] }]);
  assert.deepEqual(emptyOnly.judge(""), { score: 1, passed: true, answer: "" });
  assert.deepEqual(emptyOnly.judge("a"), { score: 0, passed: false, answer: "" });
});

test("编辑次数较少的候选相似度更低时，仍选真正的最高分", () => {
  // 候选 A "abcdefgxyz"：d=3，L=10，相似度 0.7。
  // 候选 B "abcdefghijwxyz"：d=4，L=14，相似度 10/14 ≈ 0.714。
  // 每个选项不超过 4 码点，因此拆成多个片段表达。
  const matcher = new AnswerMatcher([
    { segments: [["abc"], ["def"], ["gxyz"]] },
    { segments: [["abcd"], ["efgh"], ["ijwx"], ["yz"]] },
  ]);
  const result = matcher.judge("abcdefghij");
  assert.equal(result.score, 10 / 14);
  assert.equal(result.passed, false);
  assert.equal(result.answer, "abcdefghijwxyz");
});

test("恰好 80% 判正确，略低于 80% 判错误", () => {
  const matcher = new AnswerMatcher([{ segments: [["ab"], ["cde"]] }]);
  // d=1，L=5 → 恰好 0.8。
  assert.deepEqual(matcher.judge("abcdx"), {
    score: 0.8,
    passed: true,
    answer: "abcde",
  });
  // d=2，L=5 → 0.6。
  assert.deepEqual(matcher.judge("abcxy"), {
    score: 0.6,
    passed: false,
    answer: "abcde",
  });

  const longer = new AnswerMatcher([
    { segments: [["ab"], ["cd"], ["ef"], ["gh"], ["ij"]] },
  ]);
  // d=2，L=10 → 恰好 0.8。
  assert.equal(longer.judge("abcdefgh").passed, true);
  // d=3，L=10 → 0.7。
  assert.equal(longer.judge("abcdefg").passed, false);
});

test("多模板取全体合法回答的最高分", () => {
  const matcher = new AnswerMatcher([
    { segments: [["abcd"]] },
    { segments: [["hi", ""], ["", "xy"]] },
  ]);
  const result = matcher.judge("hixy");
  assert.equal(result.score, 1);
  assert.equal(result.answer, "hixy");
});

// ---------- 暴力对照 ----------

test("随机小规模输入与暴力枚举结果一致", () => {
  const rng = makeRng(20261007);
  const alphabet = ["a", "b", "c", " ", ".", "😀", "é"];
  const randomOption = (): string => {
    const len = Math.floor(rng() * 3); // 0..2 码点，含空串
    let s = "";
    for (let i = 0; i < len; i += 1) {
      s += alphabet[Math.floor(rng() * alphabet.length)];
    }
    return s;
  };

  for (let iter = 0; iter < 300; iter += 1) {
    const templateCount = 1 + Math.floor(rng() * 2);
    const templates: AnswerTemplate[] = [];
    for (let t = 0; t < templateCount; t += 1) {
      const segmentCount = 1 + Math.floor(rng() * 4);
      const segments: string[][] = [];
      for (let s = 0; s < segmentCount; s += 1) {
        const optionCount = 1 + Math.floor(rng() * 3);
        const options = new Set<string>();
        while (options.size < optionCount) options.add(randomOption());
        segments.push([...options]);
      }
      templates.push({ segments });
    }
    let submission = "";
    const subLen = Math.floor(rng() * 9);
    for (let i = 0; i < subLen; i += 1) {
      submission += alphabet[Math.floor(rng() * alphabet.length)];
    }

    const result = new AnswerMatcher(templates).judge(submission);
    const expected = bruteScore(templates, submission);
    assert.equal(
      result.score,
      expected,
      `iter=${iter} submission=${JSON.stringify(submission)}`,
    );
    assert.equal(result.passed, expected >= 0.8);

    // 返回的回答必须合法且确实达到该分数。
    const legalSet = new Set(templates.flatMap(enumerate));
    assert.ok(legalSet.has(result.answer), `iter=${iter} answer not legal`);
    const answerLen = cps(result.answer).length;
    const L = Math.max(answerLen, cps(submission).length);
    const answerSim =
      L === 0 ? 1 : (L - lev(cps(result.answer), cps(submission))) / L;
    assert.equal(answerSim, result.score, `iter=${iter} answer score mismatch`);
  }
});

// ---------- 上限规模结构实例 ----------

test("上限规模模板集中找到已知最优组合", () => {
  // 4 模板 × 48 片段 × 3 选项：每组 3^48 条合法回答，无法枚举。
  // 选项取 2 码点，使完整合法回答（96 码点）不超过提交上限 128 码点。
  const templates: AnswerTemplate[] = [];
  for (let t = 0; t < 4; t += 1) {
    const segments: string[][] = [];
    for (let s = 0; s < 48; s += 1) {
      segments.push([
        `${String.fromCharCode(0x30 + ((s + t) % 10))}x`,
        `${String.fromCharCode(0x30 + ((s + t) % 10))}y`,
        `${String.fromCharCode(0x30 + ((s + t) % 10))}z`,
      ]);
    }
    templates.push({ segments });
  }
  const matcher = new AnswerMatcher(templates);

  // 取模板 2 的一条具体合法回答作为提交，必须精确命中。
  const exact = templates[2]!.segments
    .map((segment, i) => segment[i % 3]!)
    .join("");
  const hit = matcher.judge(exact);
  assert.equal(hit.score, 1);
  assert.equal(hit.passed, true);
  assert.equal(hit.answer, exact);

  // 改动一个码点：d=1，L=96，相似度 95/96。
  const tweaked = exact.slice(0, 10) + "Z" + exact.slice(11);
  const near = matcher.judge(tweaked);
  assert.equal(near.score, 95 / 96);
  assert.equal(near.passed, true);
});

test("同一组模板连续判定互不影响", () => {
  const templates: AnswerTemplate[] = [
    { segments: [["ab", "abc"], ["d", ""]] },
    { segments: [["hi", "hey"], ["", "yo"]] },
  ];
  const matcher = new AnswerMatcher(templates);
  const fresh = new AnswerMatcher(templates);
  const submissions = ["abd", "hi", "heyyo", "abc", "xyz", ""];
  for (let round = 0; round < 3; round += 1) {
    for (const submission of submissions) {
      assert.deepEqual(matcher.judge(submission), fresh.judge(submission));
    }
  }
});

// ---------- 参数校验 ----------

test("超出约束的输入抛出异常", () => {
  assert.throws(() => new AnswerMatcher([]), RangeError);
  assert.throws(
    () => new AnswerMatcher(Array(5).fill({ segments: [] })),
    RangeError,
  );
  assert.throws(
    () =>
      new AnswerMatcher([
        { segments: Array(49).fill(["a"]) },
      ]),
    RangeError,
  );
  assert.throws(
    () => new AnswerMatcher([{ segments: [["a", "b", "c", "d"]] }]),
    RangeError,
  );
  assert.throws(
    () => new AnswerMatcher([{ segments: [["abcde"]] }]),
    RangeError,
  );
  const matcher = new AnswerMatcher([{ segments: [["a"]] }]);
  assert.throws(() => matcher.judge("x".repeat(129)), RangeError);
});
