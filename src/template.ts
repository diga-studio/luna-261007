import { toCodePoints } from "./codepoints.js";
import type { AnswerTemplate } from "./types.js";

/** ε 边的码点标记（空选项不消耗码点）。 */
export const EPSILON = -1;

/** 自动机中的一条边。 */
export interface CompiledEdge {
  readonly from: number;
  readonly to: number;
  /** 消耗的码点；EPSILON 表示不消耗。 */
  readonly char: number;
}

/** 编译后的单个模板。 */
export interface CompiledTemplate {
  /** 状态数；状态按拓扑序编号，0 为起点。 */
  readonly stateCount: number;
  /** 每个状态的入边（回溯用）。 */
  readonly preds: readonly (readonly CompiledEdge[])[];
  /** 每个状态的出边（前推用）。 */
  readonly succs: readonly (readonly CompiledEdge[])[];
  /** 接受状态编号。 */
  readonly accept: number;
  /** 每个状态可达的候选长度列表（升序、去重）。 */
  readonly reachableLengths: readonly (readonly number[])[];
  /** 每个状态的“长度 → 行号”映射（-1 表示该长度不可达）。 */
  readonly lengthIndex: readonly Int32Array[];
}

const MAX_TEMPLATES = 4;
const MAX_SEGMENTS = 48;
const MAX_OPTIONS = 3;
const MAX_OPTION_CODE_POINTS = 4;

/** 校验并编译单个模板。 */
function compileOne(template: AnswerTemplate, index: number): CompiledTemplate {
  const segments = template.segments;
  if (!Array.isArray(segments) || segments.length > MAX_SEGMENTS) {
    throw new RangeError(
      `template ${index}: segments must be an array of at most ${MAX_SEGMENTS}`,
    );
  }

  const preds: CompiledEdge[][] = [[]];
  const succs: CompiledEdge[][] = [[]];
  let boundary = 0;

  const addState = (): number => {
    preds.push([]);
    succs.push([]);
    return preds.length - 1;
  };
  const addEdge = (from: number, to: number, char: number): void => {
    const edge: CompiledEdge = { from, to, char };
    succs[from]!.push(edge);
    preds[to]!.push(edge);
  };

  for (const segment of segments) {
    if (!Array.isArray(segment) || segment.length < 1 || segment.length > MAX_OPTIONS) {
      throw new RangeError(
        `template ${index}: each segment needs 1..${MAX_OPTIONS} options`,
      );
    }
    // 先建选项字符链，再建下一边界，保证边总是从小编号指向大编号（拓扑序）。
    const tails: { from: number; char: number }[] = [];
    for (const option of segment) {
      if (typeof option !== "string") {
        throw new TypeError(`template ${index}: option must be a string`);
      }
      const chars = toCodePoints(option);
      if (chars.length > MAX_OPTION_CODE_POINTS) {
        throw new RangeError(
          `template ${index}: option exceeds ${MAX_OPTION_CODE_POINTS} code points`,
        );
      }
      if (chars.length === 0) {
        tails.push({ from: boundary, char: EPSILON });
        continue;
      }
      let from = boundary;
      for (let i = 0; i < chars.length - 1; i += 1) {
        const to = addState();
        addEdge(from, to, chars[i]!);
        from = to;
      }
      tails.push({ from, char: chars[chars.length - 1]! });
    }
    const nextBoundary = addState();
    for (const tail of tails) {
      addEdge(tail.from, nextBoundary, tail.char);
    }
    boundary = nextBoundary;
  }

  const stateCount = preds.length;
  const accept = boundary;

  const lengthSets: Set<number>[] = Array.from(
    { length: stateCount },
    () => new Set<number>(),
  );
  lengthSets[0]!.add(0);
  for (let s = 0; s < stateCount; s += 1) {
    for (const edge of succs[s]!) {
      const step = edge.char === EPSILON ? 0 : 1;
      for (const len of lengthSets[s]!) {
        lengthSets[edge.to]!.add(len + step);
      }
    }
  }
  const reachableLengths = lengthSets.map((set) =>
    Array.from(set).sort((a, b) => a - b),
  );
  const lengthIndex = reachableLengths.map((lengths) => {
    const max = lengths[lengths.length - 1] ?? 0;
    const index = new Int32Array(max + 1).fill(-1);
    lengths.forEach((len, i) => {
      index[len] = i;
    });
    return index;
  });

  return { stateCount, preds, succs, accept, reachableLengths, lengthIndex };
}

/** 把一组回答模板编译为可重复判定的内部结构。 */
export function compileTemplates(
  templates: readonly AnswerTemplate[],
): CompiledTemplate[] {
  if (!Array.isArray(templates) || templates.length < 1 || templates.length > MAX_TEMPLATES) {
    throw new RangeError(`need 1..${MAX_TEMPLATES} templates`);
  }
  return templates.map((template, index) => compileOne(template, index));
}
