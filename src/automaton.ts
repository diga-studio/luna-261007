import type { AnswerTemplate } from "./types.js";

/**
 * 把模板展开成一个无环字符自动机（DAG）：
 * 每个状态表示“已生成到某片段某选项的某个位置”，边携带一个码点或 epsilon。
 * 状态编号即拓扑序（边只从小编号指向大编号）。
 */
export interface TemplateAutomaton {
  /** 状态数量。 */
  readonly stateCount: number;
  /** 接受状态（最后一片段之后的边界状态）编号。 */
  readonly acceptState: number;
  /** 每个状态的出边：码点（空串表示 epsilon）与目标状态。 */
  readonly edges: ReadonlyArray<ReadonlyArray<{ readonly ch: string; readonly to: number }>>;
  /** 到达每个状态所能生成串的最小码点长度。 */
  readonly minLen: Uint32Array;
  /** 到达每个状态所能生成串的最大码点长度。 */
  readonly maxLen: Uint32Array;
  /** 任一合法回答的最大码点长度。 */
  readonly totalMaxLen: number;
}

export function buildAutomaton(template: AnswerTemplate): TemplateAutomaton {
  // 状态编号即拓扑序：B_0, 片段0的内部状态, B_1, 片段1的内部状态, ...
  // B_i 是第 i 个片段之前的边界状态，B_S 是接受状态。
  const edges: Array<Array<{ ch: string; to: number }>> = [];
  const newState = (): number => {
    edges.push([]);
    return edges.length - 1;
  };

  let boundary = newState(); // B_0
  for (const segment of template) {
    // 同一片段内的重复选项去重，不影响语言。
    const options = Array.from(new Set(segment));
    const pendingToNext: Array<{ ch: string; from: number }> = [];
    for (const option of options) {
      const chars = Array.from(option);
      if (chars.length === 0) {
        pendingToNext.push({ ch: "", from: boundary });
        continue;
      }
      let from = boundary;
      for (let p = 0; p < chars.length - 1; p++) {
        const next = newState();
        edges[from]!.push({ ch: chars[p]!, to: next });
        from = next;
      }
      pendingToNext.push({ ch: chars[chars.length - 1]!, from });
    }
    const nextBoundary = newState();
    for (const { ch, from } of pendingToNext) {
      edges[from]!.push({ ch, to: nextBoundary });
    }
    boundary = nextBoundary;
  }

  const stateCount = edges.length;
  const acceptState = boundary;

  const minLen = new Uint32Array(stateCount).fill(0xffffffff);
  const maxLen = new Uint32Array(stateCount);
  minLen[0] = 0;
  for (let u = 0; u < stateCount; u++) {
    for (const { ch, to } of edges[u]!) {
      const step = ch === "" ? 0 : 1;
      const via = minLen[u]! + step;
      if (via < minLen[to]!) minLen[to] = via;
      const viaMax = maxLen[u]! + step;
      if (viaMax > maxLen[to]!) maxLen[to] = viaMax;
    }
  }

  return {
    stateCount,
    acceptState,
    edges,
    minLen,
    maxLen,
    totalMaxLen: maxLen[acceptState]!,
  };
}
