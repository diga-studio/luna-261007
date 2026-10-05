import { tokenize } from "./tokenize.js";
import type { AddressRule } from "./types.js";

interface NormalizedRule {
  /** 是否为限州规则。 */
  stateSpecific: boolean;
  input: readonly string[];
  output: readonly string[];
}

/** 校验并规范化适用于指定州的规则；去重且与规则顺序无关。 */
function normalizeRules(
  state: string,
  rules: readonly AddressRule[],
): NormalizedRule[] {
  const seen = new Set<string>();
  const normalized: NormalizedRule[] = [];
  for (const rule of rules) {
    if (rule.state !== null && rule.state !== state) continue;
    const input = rule.input.flatMap((phrase) => tokenize(phrase));
    const output = rule.output.flatMap((phrase) => tokenize(phrase));
    if (input.length === 0) {
      throw new Error("address rule input must be a non-empty token group");
    }
    if (output.length === 0) {
      throw new Error("address rule output must be a non-empty token group");
    }
    if (output.some((token) => /\d/.test(token))) {
      throw new Error("address rule output must not contain digit tokens");
    }
    const key = JSON.stringify([rule.state, input, output]);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ stateSpecific: rule.state !== null, input, output });
  }
  return normalized;
}

function matchesAt(
  tokens: readonly string[],
  start: number,
  input: readonly string[],
): boolean {
  if (start + input.length > tokens.length) return false;
  for (let k = 0; k < input.length; k += 1) {
    if (tokens[start + k] !== input[k]) return false;
  }
  return true;
}

interface Candidate {
  sequence: string[];
  /** 限州规则覆盖的原词元数。 */
  stateCovered: number;
  /** 全部规则覆盖的原词元数。 */
  covered: number;
  /** 使用的规则数。 */
  rulesUsed: number;
}

/** 枚举原文本上全部互不重叠替换产生的解释（替换输出不再参与规则）。 */
function enumerate(
  tokens: readonly string[],
  rules: readonly NormalizedRule[],
): Candidate[] {
  const results: Candidate[] = [];
  const walk = (
    index: number,
    sequence: string[],
    stateCovered: number,
    covered: number,
    rulesUsed: number,
  ): void => {
    if (index >= tokens.length) {
      results.push({ sequence, stateCovered, covered, rulesUsed });
      return;
    }
    walk(index + 1, [...sequence, tokens[index]], stateCovered, covered, rulesUsed);
    for (const rule of rules) {
      if (matchesAt(tokens, index, rule.input)) {
        walk(
          index + rule.input.length,
          [...sequence, ...rule.output],
          stateCovered + (rule.stateSpecific ? rule.input.length : 0),
          covered + rule.input.length,
          rulesUsed + 1,
        );
      }
    }
  };
  walk(0, [], 0, 0, 0);
  return results;
}

function comparePriority(a: Candidate, b: Candidate): number {
  if (a.stateCovered !== b.stateCovered) return b.stateCovered - a.stateCovered;
  if (a.covered !== b.covered) return b.covered - a.covered;
  return a.rulesUsed - b.rulesUsed;
}

/**
 * 计算原文本在指定州的全部最高业务优先级有效解释（按词元序列去重）。
 * 优先级：限州规则覆盖原词元数最大 → 全部规则覆盖原词元数最大 → 使用规则数最小。
 */
export function validInterpretations(
  tokens: readonly string[],
  state: string,
  rules: readonly AddressRule[],
): string[][] {
  const applicable = normalizeRules(state, rules);
  const candidates = enumerate(tokens, applicable);
  let best: Candidate[] = [];
  for (const candidate of candidates) {
    if (best.length === 0 || comparePriority(candidate, best[0]) < 0) {
      best = [candidate];
    } else if (comparePriority(candidate, best[0]) === 0) {
      best.push(candidate);
    }
  }
  const sequences = new Map<string, string[]>();
  for (const candidate of best) {
    sequences.set(candidate.sequence.join(""), candidate.sequence);
  }
  return [...sequences.values()];
}
