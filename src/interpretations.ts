import type { AddressRule } from "./types.js";

const DIGIT_PATTERN = /[0-9]/;

/** 一条解释：对原词元序列应用若干互不重叠的替换。 */
export interface Interpretation {
  /** 替换后的完整词元序列。 */
  readonly tokens: readonly string[];
  /** 限州规则覆盖的原词元数。 */
  readonly stateCovered: number;
  /** 所有规则覆盖的原词元总数。 */
  readonly totalCovered: number;
  /** 使用的规则数。 */
  readonly ruleCount: number;
}

interface NormalizedRule {
  readonly from: readonly string[];
  readonly to: readonly string[];
  readonly stateSpecific: boolean;
}

function normalizeRules(
  rules: readonly AddressRule[],
  state: string,
): NormalizedRule[] {
  const applicable = rules.filter(
    (rule) => rule.state === undefined || rule.state === state,
  );
  return applicable.map((rule, index) => {
    if (rule.from.length === 0) {
      throw new TypeError(`rule ${index}: "from" must be non-empty`);
    }
    if (rule.to.length === 0) {
      throw new TypeError(`rule ${index}: "to" must be non-empty`);
    }
    for (const token of [...rule.from, ...rule.to]) {
      if (DIGIT_PATTERN.test(token)) {
        throw new TypeError(
          `rule ${index}: tokens must not contain digits, got "${token}"`,
        );
      }
    }
    return {
      from: rule.from.map((token) => token.toLowerCase()),
      to: rule.to.map((token) => token.toLowerCase()),
      stateSpecific: rule.state !== undefined,
    };
  });
}

/**
 * 生成原文本上所有互不重叠替换产生的解释，
 * 并只保留业务优先级最高的解释。
 *
 * 优先级：先最大化限州规则覆盖的原词元数，再最大化所有规则覆盖的
 * 原词元数，最后最小化使用规则数。同优先级的解释全部保留；
 * 与规则顺序及重复规则无关。
 */
export function bestInterpretations(
  tokens: readonly string[],
  rules: readonly AddressRule[],
  state: string,
): Interpretation[] {
  const normalized = normalizeRules(rules, state);
  const all: Interpretation[] = [];

  const walk = (
    pos: number,
    out: string[],
    stateCovered: number,
    totalCovered: number,
    ruleCount: number,
  ): void => {
    if (pos >= tokens.length) {
      all.push({ tokens: out, stateCovered, totalCovered, ruleCount });
      return;
    }
    // 不覆盖当前词元，原样保留。
    walk(pos + 1, [...out, tokens[pos]], stateCovered, totalCovered, ruleCount);
    // 尝试每条在当前位置匹配的规则；替换输出不再参与规则。
    for (const rule of normalized) {
      if (pos + rule.from.length > tokens.length) continue;
      let matches = true;
      for (let i = 0; i < rule.from.length; i += 1) {
        if (tokens[pos + i] !== rule.from[i]) {
          matches = false;
          break;
        }
      }
      if (!matches) continue;
      walk(
        pos + rule.from.length,
        [...out, ...rule.to],
        stateCovered + (rule.stateSpecific ? rule.from.length : 0),
        totalCovered + rule.from.length,
        ruleCount + 1,
      );
    }
  };
  walk(0, [], 0, 0, 0);

  let best: Interpretation[] = [];
  for (const candidate of all) {
    const current = best[0];
    if (
      current === undefined ||
      candidate.stateCovered > current.stateCovered ||
      (candidate.stateCovered === current.stateCovered &&
        (candidate.totalCovered > current.totalCovered ||
          (candidate.totalCovered === current.totalCovered &&
            candidate.ruleCount < current.ruleCount)))
    ) {
      best = [candidate];
    } else if (
      candidate.stateCovered === current.stateCovered &&
      candidate.totalCovered === current.totalCovered &&
      candidate.ruleCount === current.ruleCount
    ) {
      best.push(candidate);
    }
  }
  return best;
}
