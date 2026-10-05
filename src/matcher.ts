import { fromCodePoints, toCodePoints } from "./codepoints.js";
import { EPSILON, type CompiledTemplate } from "./template.js";
import type { JudgeResult } from "./types.js";

const INF = 0xffff;
const MAX_SUBMISSION_CODE_POINTS = 128;
const PASS_NUMERATOR = 4; // 达标线：相似度 >= 4/5（即 80%）
const PASS_DENOMINATOR = 5;

/** 单个模板的 DP 结果：每个 (状态, 可达长度) 一行的最小编辑距离。 */
interface TemplateRun {
  readonly buffer: Uint16Array;
  readonly offsets: readonly number[];
  readonly rowWidth: number;
}

/** 计算一个模板对 T 的 DP 表。行 行 = (状态, 候选长度)，列 = T 前缀长度。 */
function runTemplate(template: CompiledTemplate, target: readonly number[]): TemplateRun {
  const m = target.length;
  const rowWidth = m + 1;
  const offsets = new Array<number>(template.stateCount);
  let total = 0;
  for (let s = 0; s < template.stateCount; s += 1) {
    offsets[s] = total;
    total += template.reachableLengths[s]!.length * rowWidth;
  }
  const buffer = new Uint16Array(total).fill(INF);

  // 起点：长度 0，只靠前缀插入。
  const startRow = offsets[0]!;
  for (let j = 0; j <= m; j += 1) {
    buffer[startRow + j] = j;
  }

  for (let s = 0; s < template.stateCount; s += 1) {
    const base = offsets[s]!;
    const lengths = template.reachableLengths[s]!;
    const succs = template.succs[s]!;
    for (let li = 0; li < lengths.length; li += 1) {
      const row = base + li * rowWidth;
      // 行内插入传播（消耗 T 的码点，不消耗候选字符）。
      for (let j = 1; j <= m; j += 1) {
        const prev = buffer[row + j - 1]!;
        if (prev !== INF && prev + 1 < buffer[row + j]!) {
          buffer[row + j] = prev + 1;
        }
      }
      // 沿出边前推。
      for (const edge of succs) {
        const step = edge.char === EPSILON ? 0 : 1;
        const targetLength = lengths[li]! + step;
        const ti = template.lengthIndex[edge.to]![targetLength]!;
        const tRow = offsets[edge.to]! + ti * rowWidth;
        if (edge.char === EPSILON) {
          for (let j = 0; j <= m; j += 1) {
            const v = buffer[row + j]!;
            if (v < buffer[tRow + j]!) {
              buffer[tRow + j] = v;
            }
          }
        } else {
          const char = edge.char;
          for (let j = 0; j <= m; j += 1) {
            const v = buffer[row + j]!;
            if (v === INF) continue;
            // 删除候选字符。
            if (v + 1 < buffer[tRow + j]!) {
              buffer[tRow + j] = v + 1;
            }
            // 匹配 / 替换 T[j]。
            if (j < m) {
              const cost = char === target[j]! ? v : v + 1;
              if (cost < buffer[tRow + j + 1]!) {
                buffer[tRow + j + 1] = cost;
              }
            }
          }
        }
      }
    }
  }
  return { buffer, offsets, rowWidth };
}

/** 在 DP 表中回溯一条取得 (accept, length, m) 处最优值的合法回答。 */
function backtrack(
  template: CompiledTemplate,
  run: TemplateRun,
  target: readonly number[],
  length: number,
): string {
  const m = target.length;
  const { buffer, offsets, rowWidth } = run;
  const cell = (state: number, len: number, j: number): number => {
    const li = template.lengthIndex[state]![len]!;
    if (li < 0) return INF;
    return buffer[offsets[state]! + li * rowWidth + j]!;
  };

  const emitted: number[] = [];
  let state = template.accept;
  let len = length;
  let j = m;
  while (state !== 0 || len !== 0 || j !== 0) {
    const v = cell(state, len, j);
    // 插入 T[j-1]。
    if (j > 0 && cell(state, len, j - 1) === v - 1) {
      j -= 1;
      continue;
    }
    let advanced = false;
    for (const edge of template.preds[state]!) {
      if (edge.char === EPSILON) {
        if (cell(edge.from, len, j) === v) {
          state = edge.from;
          advanced = true;
          break;
        }
        continue;
      }
      if (len === 0) continue;
      // 删除候选字符。
      if (cell(edge.from, len - 1, j) === v - 1) {
        emitted.push(edge.char);
        state = edge.from;
        len -= 1;
        advanced = true;
        break;
      }
      // 匹配 / 替换。
      if (j > 0) {
        const cost = edge.char === target[j - 1]! ? 0 : 1;
        if (cell(edge.from, len - 1, j - 1) === v - cost) {
          emitted.push(edge.char);
          state = edge.from;
          len -= 1;
          j -= 1;
          advanced = true;
          break;
        }
      }
    }
    if (!advanced) {
      throw new Error("backtrack failed: inconsistent DP table");
    }
  }
  emitted.reverse();
  return fromCodePoints(emitted);
}

/** 对一句学习者回答做整句相似度判定。 */
export function judgeAnswer(
  compiled: readonly CompiledTemplate[],
  submission: string,
): JudgeResult {
  const target = toCodePoints(submission);
  if (target.length > MAX_SUBMISSION_CODE_POINTS) {
    throw new RangeError(
      `submission exceeds ${MAX_SUBMISSION_CODE_POINTS} code points`,
    );
  }
  const m = target.length;

  // 用 (L - d) / L 的整数交叉相乘比较相似度，避免浮点误差；L = max(候选长度, m)。
  let bestNum = -1; // L - d
  let bestDen = 1; // L
  let bestTemplate = -1;
  let bestLength = 0;
  let bestRun: TemplateRun | null = null;

  for (let t = 0; t < compiled.length; t += 1) {
    const template = compiled[t]!;
    const run = runTemplate(template, target);
    const acceptLengths = template.reachableLengths[template.accept]!;
    const acceptBase = run.offsets[template.accept]!;
    for (let li = 0; li < acceptLengths.length; li += 1) {
      const len = acceptLengths[li]!;
      const d = run.buffer[acceptBase + li * run.rowWidth + m]!;
      const L = Math.max(len, m);
      const num = L === 0 ? 1 : L - d; // 两句均空时相似度为 1
      const den = L === 0 ? 1 : L;
      if (num * bestDen > bestNum * den) {
        bestNum = num;
        bestDen = den;
        bestTemplate = t;
        bestLength = len;
        bestRun = run;
      }
    }
  }

  const template = compiled[bestTemplate]!;
  const answer = backtrack(template, bestRun!, target, bestLength);
  const score = bestNum / bestDen;
  const passed = bestNum * PASS_DENOMINATOR >= bestDen * PASS_NUMERATOR;
  return { score, passed, answer };
}
