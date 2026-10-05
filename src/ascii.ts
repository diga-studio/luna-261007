import { Utf8Validator } from './utf8.js';
import type { BoundingBox, GeometryStats } from './types.js';

const MAX_TOKEN = 64;

const SP = 0x20;
const TAB = 0x09;
const CR = 0x0d;
const LF = 0x0a;

function isBlank(b: number): boolean {
  return b === SP || b === TAB || b === CR || b === LF;
}

const NUMBER_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** facet 固定序列：字符串为关键字字面量；'n' 法线分量；'v' 顶点分量。 */
type SeqItem = string | 'n' | 'v';
const FACET_SEQ: readonly SeqItem[] = [
  'facet', 'normal', 'n', 'n', 'n', 'outer', 'loop',
  'vertex', 'v', 'v', 'v',
  'vertex', 'v', 'v', 'v',
  'vertex', 'v', 'v', 'v',
  'endloop', 'endfacet',
];

type State = 'ExpectSolid' | 'InName' | 'NameCR' | 'ExpectFacetOrEnd' | 'FacetSeq';

/**
 * ASCII STL 增量解析器。
 * - 一个或多个 solid 块；solid/endsolid 独占一行，可带 UTF-8 名称（增量校验，不缓存）。
 * - facet 严格依次为 facet normal/3 数/outer loop/3 组 vertex/endloop/endfacet。
 * - 几何 token 由空格、制表符、CR、LF 分隔；token 最长 64 字节；数值必须有限。
 * - 行结束支持 LF 与 CRLF；最后一条 endsolid 可在 EOF 结束。
 * 内部状态固定大小（64 字节 token 缓冲 + 少量标量）。
 */
export class AsciiParser {
  private state: State = 'ExpectSolid';
  private failed = false;

  private token = new Uint8Array(MAX_TOKEN);
  private tokenLen = 0;
  private tokenLineStart = true;
  private lineStart = true; // 自上一个 LF（或 BOF）以来只见过空白

  private utf8 = new Utf8Validator();
  private nameNext: 'facet' | 'maybeEnd' = 'facet';
  private blocksSeen = 0;

  private seqIndex = 0;
  private vertexCoord = 0; // 当前顶点内的分量序号 0..2

  private triCount = 0;
  private min = [Infinity, Infinity, Infinity];
  private max = [-Infinity, -Infinity, -Infinity];

  push(chunk: Uint8Array): void {
    if (this.failed) return;
    for (let i = 0; i < chunk.length; i += 1) {
      if (!this.step(chunk[i]!)) {
        this.failed = true;
        return;
      }
    }
  }

  finish(): GeometryStats | null {
    if (this.failed) return null;
    // EOF 冲刷未完成的 token
    if (this.tokenLen > 0 && this.state !== 'InName' && this.state !== 'NameCR') {
      if (!this.dispatch()) return null;
    }
    if (this.state === 'ExpectSolid') {
      // 允许末尾空白；要求至少一个完整 solid 块
      if (this.blocksSeen === 0) return null;
    } else if (this.state === 'InName' && this.nameNext === 'maybeEnd') {
      // 最后一条 endsolid 在 EOF 结束
      if (!this.utf8.atBoundary()) return null;
    } else {
      return null;
    }
    return { triangleCount: this.triCount, bboxMm: this.bbox() };
  }

  get dead(): boolean {
    return this.failed;
  }

  /** 处理单个字节；返回 false 表示格式错误。 */
  private step(b: number): boolean {
    if (this.state === 'InName' || this.state === 'NameCR') {
      return this.nameByte(b);
    }
    // token 化状态
    if (isBlank(b)) {
      if (this.tokenLen > 0 && !this.dispatch()) return false;
      // 分发后状态可能已切换为 InName（solid/endsolid 行），
      // 当前空白字节必须在新状态下重新处理（例如空名称直接换行）
      if (this.inNameState()) return this.nameByte(b);
      if (b === LF) this.lineStart = true;
      return true;
    }
    if (this.tokenLen === 0) this.tokenLineStart = this.lineStart;
    this.lineStart = false;
    if (this.tokenLen >= MAX_TOKEN) return false;
    this.token[this.tokenLen] = b;
    this.tokenLen += 1;
    return true;
  }

  /** 读取当前状态（方法调用避免 TS 对属性收窄的误判）。 */
  private inNameState(): boolean {
    return this.state === 'InName' || this.state === 'NameCR';
  }

  /** 处理 solid/endsolid 行名称部分的字节。 */
  private nameByte(b: number): boolean {
    if (this.state === 'NameCR') {
      if (b !== LF) return false;
      return this.endLine();
    }
    if (b === LF) return this.endLine();
    if (b === CR) {
      this.state = 'NameCR';
      return true;
    }
    return this.utf8.push(b);
  }

  /** solid/endsolid 行结束（LF 已消费）。 */
  private endLine(): boolean {
    if (!this.utf8.atBoundary()) return false;
    this.utf8 = new Utf8Validator();
    this.lineStart = true;
    if (this.nameNext === 'facet') {
      this.state = 'ExpectFacetOrEnd';
    } else {
      this.blocksSeen += 1;
      this.state = 'ExpectSolid';
    }
    return true;
  }

  private tokenString(): string {
    let s = '';
    for (let i = 0; i < this.tokenLen; i += 1) s += String.fromCharCode(this.token[i]!);
    return s;
  }

  /** 分发一个完整 token；返回 false 表示格式错误。 */
  private dispatch(): boolean {
    const t = this.tokenString();
    this.tokenLen = 0;
    switch (this.state) {
      case 'ExpectSolid':
        if (t !== 'solid') return false;
        this.state = 'InName';
        this.nameNext = 'facet';
        return true;
      case 'ExpectFacetOrEnd':
        if (t === 'facet') {
          this.state = 'FacetSeq';
          this.seqIndex = 1;
          this.vertexCoord = 0;
          return true;
        }
        if (t === 'endsolid') {
          if (!this.tokenLineStart) return false; // endsolid 必须独占一行
          this.state = 'InName';
          this.nameNext = 'maybeEnd';
          return true;
        }
        return false;
      case 'FacetSeq':
        return this.facetToken(t);
      default:
        return false;
    }
  }

  private facetToken(t: string): boolean {
    const want = FACET_SEQ[this.seqIndex]!;
    if (want === 'n' || want === 'v') {
      if (!NUMBER_RE.test(t)) return false;
      const v = Number(t);
      if (!Number.isFinite(v)) return false;
      if (want === 'v') {
        const axis = this.vertexCoord;
        if (v < this.min[axis]!) this.min[axis] = v;
        if (v > this.max[axis]!) this.max[axis] = v;
        this.vertexCoord = (this.vertexCoord + 1) % 3;
      }
    } else if (t !== want) {
      return false;
    }
    this.seqIndex += 1;
    if (this.seqIndex === FACET_SEQ.length) {
      this.triCount += 1;
      this.state = 'ExpectFacetOrEnd';
    }
    return true;
  }

  private bbox(): BoundingBox | null {
    if (this.triCount === 0) return null;
    return {
      min: { x: this.min[0]!, y: this.min[1]!, z: this.min[2]! },
      max: { x: this.max[0]!, y: this.max[1]!, z: this.max[2]! },
    };
  }
}
