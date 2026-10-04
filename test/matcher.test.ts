import assert from "node:assert/strict";
import test from "node:test";
import { AnswerMatcher, editDistance, similarity } from "../src/index.js";
import type { AnswerTemplate } from "../src/types.js";
import { bruteForceBest, enumerateAnswers, isLegalAnswer, makeRng } from "./helpers.js";

function assertMatchesBruteForce(templates: readonly AnswerTemplate[], answer: string): void {
  const matcher = new AnswerMatcher(templates);
  const result = matcher.judge(answer);
  const best = bruteForceBest(templates, answer);
  assert.equal(
    result.similarity,
    best.num / best.den,
    `similarity mismatch for ${JSON.stringify(answer)}`,
  );
  assert.equal(result.passed, 5 * best.num >= 4 * best.den, "passed mismatch");
  // 返回句必须合法且自身相似度等于报告的最高分。
  assert.ok(
    templates.some((t) => isLegalAnswer(t, result.answer)),
    `returned answer ${JSON.stringify(result.answer)} is not legal`,
  );
  const len = Array.from(result.answer).length;
  const n = Array.from(answer).length;
  const den = Math.max(len, n);
  const own = den === 0 ? 1 : (den - editDistance(result.answer, answer)) / den;
  assert.equal(own, result.similarity, "returned answer does not achieve reported score");
}

test("码点级编辑距离与相似度基本性质", () => {
  assert.equal(editDistance("", ""), 0);
  assert.equal(editDistance("abc", "abd"), 1);
  assert.equal(editDistance("kitten", "sitting"), 3);
  // 补充平面字符按单个码点计，不按 UTF-16 代码单元。
  assert.equal(editDistance("😀", "𠀀"), 1);
  assert.equal(editDistance("😀x", "𠀀y"), 2);
  assert.equal(similarity("", ""), 1);
  assert.equal(similarity("", "a"), 0);
  assert.equal(similarity("ab", ""), 0);
  // 大小写、空格、标点都参与比较，不做归一化。
  assert.equal(editDistance("A", "a"), 1);
  assert.equal(editDistance("a b", "ab"), 1);
  assert.equal(editDistance("好。", "好"), 1);
});

test("空选项与空句按约定计分", () => {
  const matcher = new AnswerMatcher([[["", "a"], ["", "bc"]]]);
  // 合法回答：""、"a"、"bc"、"abc"。
  const empty = matcher.judge("");
  assert.equal(empty.similarity, 1);
  assert.equal(empty.passed, true);
  assert.equal(empty.answer, "");

  assert.deepEqual(matcher.judge("a").similarity, 1);
  // "ab" 与 "abc" 差 1（maxLen=3），与 "a" 差 1（maxLen=2）：最高分 2/3。
  const ab = matcher.judge("ab");
  assert.equal(ab.similarity, 2 / 3);
  assert.equal(ab.passed, false);
  assert.equal(ab.answer, "abc");

  // 只能生成空串的模板。
  const onlyEmpty = new AnswerMatcher([[[]].length ? [[""]] : [[""]]]);
  const hit = onlyEmpty.judge("");
  assert.equal(hit.similarity, 1);
  assert.equal(hit.passed, true);
  const miss = onlyEmpty.judge("x");
  assert.equal(miss.similarity, 0);
  assert.equal(miss.passed, false);
  assert.equal(miss.answer, "");
});

test("跨片段编辑与补充平面字符", () => {
  // 合法回答：😀🎉、😀、𠀀🎉、𠀀。
  const templates: AnswerTemplate[] = [[["😀", "𠀀"], ["🎉", ""]]];
  const matcher = new AnswerMatcher(templates);
  assert.equal(matcher.judge("😀🎉").similarity, 1);
  // 学习者只写 "🎉"：最优是 "😀🎉" 删一个码点，相似度 1/2。
  const r = matcher.judge("🎉");
  assert.equal(r.similarity, 0.5);
  assert.equal(r.answer, "😀🎉");
  // 跨片段边界的对齐：目标 "a😀🎉" 需要在片段边界处整体平移对齐。
  const templates2: AnswerTemplate[] = [[["ab"], ["😀🎉", "😀"]]];
  const matcher2 = new AnswerMatcher(templates2);
  const r2 = matcher2.judge("ab😀");
  assert.equal(r2.similarity, 1);
  assertMatchesBruteForce(templates2, "a😀b🎉");
  assertMatchesBruteForce(templates, "𠀀😀");
});

test("编辑次数更少的候选相似度反而更低时仍选最高分", () => {
  // 候选 A = "0123456abc"：d=3，maxLen=10，sim=0.7。
  // 候选 B = "01234wxyz56789"：d=4，maxLen=14，sim=10/14≈0.714。
  const templates: AnswerTemplate[] = [
    [["0123"], ["456a"], ["bc"]],
    [["0123"], ["4wxy"], ["z567"], ["89"]],
  ];
  const matcher = new AnswerMatcher(templates);
  const result = matcher.judge("0123456789");
  assert.equal(result.similarity, 10 / 14);
  assert.equal(result.answer, "01234wxyz56789");
  assert.equal(result.passed, false);
  // 确认 A 的编辑距离确实更小。
  assert.ok(editDistance("0123456abc", "0123456789") < editDistance("01234wxyz56789", "0123456789"));
});

test("恰好 80% 判正确，略低于 80% 判错误", () => {
  // n=10，d=2：相似度恰好 0.8。
  const exact = new AnswerMatcher([[["0123"], ["4567"], ["ab"]]]);
  const r1 = exact.judge("0123456789");
  assert.equal(r1.similarity, 0.8);
  assert.equal(r1.passed, true);

  // n=14，d=3：相似度 11/14 ≈ 0.7857 < 0.8。
  const below = new AnswerMatcher([[["0123"], ["4567"], ["89a"], ["xyz"]]]);
  const r2 = below.judge("0123456789abcd");
  assert.equal(r2.similarity, 11 / 14);
  assert.equal(r2.passed, false);

  // 长句恰好 80%：n=15，d=3，候选 "0123456789abxyz"。
  const exact15 = new AnswerMatcher([[["0123"], ["4567"], ["89ab"], ["xyz"]]]);
  const r3 = exact15.judge("0123456789abcde");
  assert.equal(r3.similarity, 0.8);
  assert.equal(r3.passed, true);
});

test("多模板取全体合法回答的最高分", () => {
  const templates: AnswerTemplate[] = [
    [["hel"], ["lo"], [" ", ""], ["wor"], ["ld"]],
    [["good"], ["morn", "eve"], ["ing"]],
  ];
  const matcher = new AnswerMatcher(templates);
  const r = matcher.judge("goodmornings");
  // "goodmorning" 差 1（n=12，maxLen=11）→ 1 - 1/12。
  assert.equal(r.similarity, 1 - 1 / 12);
  assert.equal(r.answer, "goodmorning");
  assertMatchesBruteForce(templates, "hello  world");
});

test("随机小规模模板与暴力枚举完全一致", () => {
  const rng = makeRng(20261007);
  const alphabet = ["a", "b", "c", " ", ".", "😀", "𠀀", "好"];
  const randString = (maxLen: number): string => {
    const len = Math.floor(rng() * (maxLen + 1));
    let s = "";
    for (let i = 0; i < len; i++) s += alphabet[Math.floor(rng() * alphabet.length)];
    return s;
  };
  for (let iter = 0; iter < 300; iter++) {
    const templateCount = 1 + Math.floor(rng() * 3);
    const templates: AnswerTemplate[] = [];
    for (let t = 0; t < templateCount; t++) {
      const segCount = 1 + Math.floor(rng() * 5);
      const template: AnswerTemplate = [];
      for (let s = 0; s < segCount; s++) {
        const optCount = 1 + Math.floor(rng() * 3);
        const segment: string[] = [];
        for (let o = 0; o < optCount; o++) segment.push(randString(3));
        template.push(segment);
      }
      templates.push(template);
    }
    const answer = randString(8);
    assertMatchesBruteForce(templates, answer);
  }
});

test("同一组模板连续判定互不影响", () => {
  const templates: AnswerTemplate[] = [
    [["你好", "您好"], ["，", ""], ["老师", "李老师"], ["好", "。"]],
    [["good"], [" ", ""], ["morn", "noon"]],
  ];
  const matcher = new AnswerMatcher(templates);
  const answers = ["您好，李老师好", "goodmorn", "你好老师。", "", "good noon!"];
  const firstPass = answers.map((a) => matcher.judge(a));
  const secondPass = answers.map((a) => matcher.judge(a));
  assert.deepEqual(secondPass, firstPass);
  // 与全新匹配器的结果一致，说明没有残留状态。
  const fresh = new AnswerMatcher(templates);
  assert.deepEqual(answers.map((a) => fresh.judge(a)), firstPass);
});

test("超出规模上限的输入被拒绝", () => {
  assert.throws(() => new AnswerMatcher([]), RangeError);
  assert.throws(() => new AnswerMatcher([[], [["a"]]] as unknown as AnswerTemplate[]), RangeError);
  const tooManySegments: AnswerTemplate = Array.from({ length: 49 }, () => ["a"]);
  assert.throws(() => new AnswerMatcher([tooManySegments]), RangeError);
  assert.throws(() => new AnswerMatcher([[["a", "b", "c", "d"]]]), RangeError);
  assert.throws(() => new AnswerMatcher([[["abcde"]]]), RangeError);
  const matcher = new AnswerMatcher([[["a"]]]);
  assert.throws(() => matcher.judge("x".repeat(129)), RangeError);
  // 128 个码点（含补充平面字符）是合法的。
  assert.doesNotThrow(() => matcher.judge("😀".repeat(128)));
});

test("枚举辅助与模板语义一致", () => {
  const template: AnswerTemplate = [["a", ""], ["b", "c"]];
  assert.deepEqual(new Set(enumerateAnswers(template)), new Set(["ab", "ac", "b", "c"]));
});
