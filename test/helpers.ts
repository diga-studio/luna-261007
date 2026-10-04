import { editDistance } from "../src/levenshtein.js";
import type { AnswerTemplate } from "../src/types.js";

/** 枚举模板的全部合法回答（仅用于小规模测试）。 */
export function enumerateAnswers(template: AnswerTemplate): string[] {
  let acc: string[] = [""];
  for (const segment of template) {
    const next: string[] = [];
    for (const prefix of acc) {
      for (const option of new Set(segment)) {
        next.push(prefix + option);
      }
    }
    acc = next;
  }
  return acc;
}

export interface BestScore {
  /** 最高相似度的分子：max(len, n) - d。 */
  readonly num: number;
  /** 最高相似度的分母：max(len, n)；两句均空时为 1。 */
  readonly den: number;
}

/** 暴力法：对一组模板求全体合法回答中的最高相似度（以有理数表示）。 */
export function bruteForceBest(templates: readonly AnswerTemplate[], answer: string): BestScore {
  const n = Array.from(answer).length;
  let bestNum = -1;
  let bestDen = 1;
  for (const template of templates) {
    for (const candidate of enumerateAnswers(template)) {
      const len = Array.from(candidate).length;
      const den = Math.max(len, n);
      if (den === 0) {
        return { num: 1, den: 1 };
      }
      const num = den - editDistance(candidate, answer);
      if (num * bestDen > bestNum * den) {
        bestNum = num;
        bestDen = den;
      }
    }
  }
  return { num: bestNum, den: bestDen };
}

/** 校验一个字符串是否是某模板的合法回答（按片段顺序可分解）。 */
export function isLegalAnswer(template: AnswerTemplate, s: string): boolean {
  const chars = Array.from(s);
  // memo[segIdx][pos]：0 未知，1 可行，2 不可行。
  const width = chars.length + 1;
  const memo = new Uint8Array((template.length + 1) * width);
  const ok = (segIdx: number, pos: number): boolean => {
    if (segIdx === template.length) return pos === chars.length;
    const key = segIdx * width + pos;
    if (memo[key] !== 0) return memo[key] === 1;
    for (const option of template[segIdx]!) {
      const optChars = Array.from(option);
      if (chars.slice(pos, pos + optChars.length).join("") === option) {
        if (ok(segIdx + 1, pos + optChars.length)) {
          memo[key] = 1;
          return true;
        }
      }
    }
    memo[key] = 2;
    return false;
  };
  return ok(0, 0);
}

/** 确定性伪随机数（mulberry32），保证测试可复现。 */
export function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
