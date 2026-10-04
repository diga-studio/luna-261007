import { buildAutomaton, type TemplateAutomaton } from "./automaton.js";
import { LIMITS, type AnswerTemplate, type JudgeResult } from "./types.js";

const INF = 0xff;

interface CompiledTemplate {
  readonly automaton: TemplateAutomaton;
  /** 每个状态的入边（用于从接受状态反向回溯出一条最优回答）。 */
  readonly revEdges: ReadonlyArray<ReadonlyArray<{ readonly ch: string; readonly from: number }>>;
}

function validateTemplates(templates: readonly AnswerTemplate[]): void {
  if (templates.length < 1 || templates.length > LIMITS.maxTemplates) {
    throw new RangeError(`template count must be 1..${LIMITS.maxTemplates}`);
  }
  for (const template of templates) {
    if (template.length < 1 || template.length > LIMITS.maxSegmentsPerTemplate) {
      throw new RangeError(`segment count must be 1..${LIMITS.maxSegmentsPerTemplate}`);
    }
    for (const segment of template) {
      if (segment.length < 1 || segment.length > LIMITS.maxOptionsPerSegment) {
        throw new RangeError(`option count must be 1..${LIMITS.maxOptionsPerSegment}`);
      }
      for (const option of segment) {
        if (Array.from(option).length > LIMITS.maxOptionCodePoints) {
          throw new RangeError(`option must be at most ${LIMITS.maxOptionCodePoints} code points`);
        }
      }
    }
  }
}

function compileTemplate(template: AnswerTemplate): CompiledTemplate {
  const automaton = buildAutomaton(template);
  const revEdges: Array<Array<{ ch: string; from: number }>> = [];
  for (let u = 0; u < automaton.stateCount; u++) revEdges.push([]);
  for (let u = 0; u < automaton.stateCount; u++) {
    for (const { ch, to } of automaton.edges[u]!) {
      revEdges[to]!.push({ ch, from: u });
    }
  }
  return { automaton, revEdges };
}

/**
 * 对话练习可接受回答匹配器。
 * 装入一组模板后可反复判定学习者回答；判定结果不受先前判定影响。
 */
export class AnswerMatcher {
  private readonly compiled: readonly CompiledTemplate[];

  constructor(templates: readonly AnswerTemplate[]) {
    validateTemplates(templates);
    this.compiled = templates.map(compileTemplate);
  }

  /** 判定一句学习者回答，返回全体合法回答中的最高相似度及一条最优句。 */
  judge(learnerAnswer: string): JudgeResult {
    const target = Array.from(learnerAnswer);
    if (target.length > LIMITS.maxAnswerCodePoints) {
      throw new RangeError(`answer must be at most ${LIMITS.maxAnswerCodePoints} code points`);
    }

    let bestNum = -1; // 当前最高相似度的分子（maxLen - d）
    let bestDen = 1; // 当前最高相似度的分母（maxLen）
    let bestAnswer = "";

    for (const compiled of this.compiled) {
      const dp = runDp(compiled.automaton, target);
      const { automaton } = compiled;
      const n = target.length;
      const stride = automaton.totalMaxLen + 1;
      const rowSize = (n + 1) * stride;
      const acceptRow = automaton.acceptState * rowSize + n * stride;

      // 在该模板的所有合法回答长度 L 上取最高相似度。
      let tNum = -1;
      let tDen = 1;
      let tLen = 0;
      for (let len = 0; len <= automaton.totalMaxLen; len++) {
        const d = dp[acceptRow + len]!;
        if (d === INF) continue;
        const den = Math.max(len, n);
        if (den === 0) {
          tNum = 1;
          tDen = 1;
          tLen = 0;
          break;
        }
        const num = den - d;
        if (num * tDen > tNum * den) {
          tNum = num;
          tDen = den;
          tLen = len;
        }
      }

      if (tNum * bestDen > bestNum * tDen) {
        bestNum = tNum;
        bestDen = tDen;
        bestAnswer = reconstruct(compiled, dp, target, tLen);
      }
    }

    return {
      similarity: bestNum / bestDen,
      passed: 5 * bestNum >= 4 * bestDen,
      answer: bestAnswer,
    };
  }
}

/**
 * 在 (状态, 已匹配目标前缀 j, 已生成长度 l) 上做 DAG 动态规划：
 * dp[u][j][l] = 生成任意长度 l 的串到达状态 u、且与 target[0..j) 的最小编辑代价。
 */
function runDp(automaton: TemplateAutomaton, target: string[]): Uint8Array {
  const n = target.length;
  const stride = automaton.totalMaxLen + 1;
  const rowSize = (n + 1) * stride;
  const dp = new Uint8Array(automaton.stateCount * rowSize).fill(INF);
  dp[0] = 0;

  for (let u = 0; u < automaton.stateCount; u++) {
    const base = u * rowSize;
    const lLo = automaton.minLen[u]!;
    const lHi = Math.min(automaton.maxLen[u]!, automaton.totalMaxLen);
    const edges = automaton.edges[u]!;
    for (let j = 0; j <= n; j++) {
      const row = base + j * stride;
      for (let l = lLo; l <= lHi; l++) {
        const val = dp[row + l]!;
        if (val === INF) continue;
        // 删除：跳过 target[j]，状态不变（j 递增，同一状态内自然拓扑有序）。
        if (j < n) {
          const idx = row + stride + l;
          if (val + 1 < dp[idx]!) dp[idx] = val + 1;
        }
        for (const { ch, to } of edges) {
          const tBase = to * rowSize;
          if (ch === "") {
            const idx = tBase + j * stride + l;
            if (val < dp[idx]!) dp[idx] = val;
            continue;
          }
          // 插入：生成的码点不与任何目标码点对齐。
          const insIdx = tBase + j * stride + l + 1;
          if (val + 1 < dp[insIdx]!) dp[insIdx] = val + 1;
          // 匹配/替换：与 target[j] 对齐。
          if (j < n) {
            const cost = ch === target[j] ? val : val + 1;
            const subIdx = tBase + (j + 1) * stride + l + 1;
            if (cost < dp[subIdx]!) dp[subIdx] = cost;
          }
        }
      }
    }
  }
  return dp;
}

/** 从 (接受状态, n, bestLen) 沿最优值反向回溯，拼出一条取得该分数的合法回答。 */
function reconstruct(
  compiled: CompiledTemplate,
  dp: Uint8Array,
  target: string[],
  bestLen: number,
): string {
  const { automaton, revEdges } = compiled;
  const n = target.length;
  const stride = automaton.totalMaxLen + 1;
  const rowSize = (n + 1) * stride;

  let u = automaton.acceptState;
  let j = n;
  let l = bestLen;
  const out: string[] = [];

  while (u !== 0 || j !== 0 || l !== 0) {
    const v = dp[u * rowSize + j * stride + l]!;
    // 删除的前驱：(u, j-1, l)，代价 +1。
    if (j > 0 && dp[u * rowSize + (j - 1) * stride + l] === v - 1) {
      j -= 1;
      continue;
    }
    let advanced = false;
    for (const { ch, from } of revEdges[u]!) {
      if (ch === "") {
        if (dp[from * rowSize + j * stride + l] === v) {
          u = from;
          advanced = true;
          break;
        }
        continue;
      }
      if (l === 0) continue;
      // 匹配/替换的前驱：(from, j-1, l-1)。
      if (j > 0) {
        const cost = ch === target[j - 1] ? 0 : 1;
        if (dp[from * rowSize + (j - 1) * stride + l - 1] === v - cost) {
          out.push(ch);
          u = from;
          j -= 1;
          l -= 1;
          advanced = true;
          break;
        }
      }
      // 插入的前驱：(from, j, l-1)。
      if (dp[from * rowSize + j * stride + l - 1] === v - 1) {
        out.push(ch);
        u = from;
        l -= 1;
        advanced = true;
        break;
      }
    }
    if (!advanced) {
      throw new Error("internal error: reconstruction failed");
    }
  }
  out.reverse();
  return out.join("");
}
