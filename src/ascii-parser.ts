import { Utf8Validator } from "./utf8.js";

/**
 * Streaming parser for ASCII STL. Grammar per solid block:
 *   "solid" <name EOL>
 *   ("facet normal" n n n "outer loop"
 *    ("vertex" x y z) x3 "endloop" "endfacet")*
 *   "endsolid" <name EOL or EOF>
 *
 * Keywords lowercase; geometry tokens separated by space/tab/CR/LF.
 * "solid"/"endsolid" must be the first token of their line and the rest of
 * the line is an optional UTF-8 name (validated, never stored).
 * Numbers: decimal with optional sign/fraction/exponent, token <= 64 bytes,
 * finite value. Memory: one 64-byte token buffer + O(1) state.
 */
export type AsciiParseStatus = "pending" | "invalid" | "done";

export interface AsciiParseResult {
  status: AsciiParseStatus;
  triangleCount: number;
  bboxMin: [number, number, number];
  bboxMax: [number, number, number];
}

const MAX_TOKEN_LEN = 64;

const enum S {
  ExpectSolid,
  SolidName,
  ExpectFacetOrEndsolid,
  ExpectNormalKw,
  ExpectNormalNum,
  ExpectOuter,
  ExpectLoop,
  ExpectVertexKw,
  ExpectVertexNum,
  ExpectEndloop,
  ExpectEndfacet,
  EndName,
}

const SP = 0x20, TAB = 0x09, CR = 0x0d, LF = 0x0a;

function isSeparator(b: number): boolean {
  return b === SP || b === TAB || b === CR || b === LF;
}

function isEol(b: number): boolean {
  return b === CR || b === LF;
}

function isDigit(b: number): boolean {
  return b >= 0x30 && b <= 0x39;
}

/** Decimal number grammar: [+-]? (d+ (.d*)? | .d+) ([eE] [+-]? d+)? */
function isValidNumberToken(buf: Uint8Array, len: number): boolean {
  let i = 0;
  if (i < len && (buf[i] === 0x2b || buf[i] === 0x2d)) i++;
  let mantissaDigits = 0;
  while (i < len && isDigit(buf[i]!)) { i++; mantissaDigits++; }
  if (i < len && buf[i] === 0x2e) {
    i++;
    while (i < len && isDigit(buf[i]!)) { i++; mantissaDigits++; }
  }
  if (mantissaDigits === 0) return false;
  if (i < len && (buf[i] === 0x65 || buf[i] === 0x45)) {
    i++;
    if (i < len && (buf[i] === 0x2b || buf[i] === 0x2d)) i++;
    let expDigits = 0;
    while (i < len && isDigit(buf[i]!)) { i++; expDigits++; }
    if (expDigits === 0) return false;
  }
  return i === len;
}

function kw(word: string): Uint8Array {
  const out = new Uint8Array(word.length);
  for (let i = 0; i < word.length; i++) out[i] = word.charCodeAt(i);
  return out;
}

const KW = {
  solid: kw("solid"),
  endsolid: kw("endsolid"),
  facet: kw("facet"),
  normal: kw("normal"),
  outer: kw("outer"),
  loop: kw("loop"),
  vertex: kw("vertex"),
  endloop: kw("endloop"),
  endfacet: kw("endfacet"),
} as const;

export class AsciiStlParser {
  private status: AsciiParseStatus = "pending";
  private state: S = S.ExpectSolid;
  private readonly token = new Uint8Array(MAX_TOKEN_LEN);
  private tokenLen = 0;
  private atLineStart = true;
  private nameUtf8 = new Utf8Validator();
  private blocksSeen = 0;
  private triangles = 0;
  private normalNumCount = 0;
  private vertexNumCount = 0;
  private vertexCount = 0;
  private readonly min: [number, number, number] = [Infinity, Infinity, Infinity];
  private readonly max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  push(chunk: Uint8Array): void {
    if (this.status !== "pending") return;
    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i]!;
      if (this.state === S.SolidName || this.state === S.EndName) {
        if (isEol(b)) {
          if (!this.nameUtf8.isComplete()) {
            this.status = "invalid";
            return;
          }
          this.atLineStart = true;
          this.state = this.state === S.SolidName ? S.ExpectFacetOrEndsolid : S.ExpectSolid;
        } else {
          if (!this.nameUtf8.push(chunk.subarray(i, i + 1))) {
            this.status = "invalid";
            return;
          }
        }
        continue;
      }
      if (isSeparator(b)) {
        if (this.tokenLen > 0) {
          const wasAtLineStart = this.atLineStart;
          this.atLineStart = isEol(b);
          this.flushToken(isEol(b), wasAtLineStart);
          if (this.status !== "pending") return;
        } else if (isEol(b)) {
          this.atLineStart = true;
        }
      } else {
        if (this.tokenLen >= MAX_TOKEN_LEN) {
          this.status = "invalid";
          return;
        }
        this.token[this.tokenLen++] = b;
      }
    }
  }

  private tokenEquals(word: Uint8Array): boolean {
    if (this.tokenLen !== word.length) return false;
    for (let i = 0; i < word.length; i++) {
      if (this.token[i] !== word[i]) return false;
    }
    return true;
  }

  private parseNumberToken(): number | null {
    if (!isValidNumberToken(this.token, this.tokenLen)) return null;
    let s = "";
    for (let i = 0; i < this.tokenLen; i++) s += String.fromCharCode(this.token[i]!);
    const v = Number(s);
    return Number.isFinite(v) ? v : null;
  }

  private flushToken(endedByEol: boolean, wasAtLineStart: boolean): void {
    const fail = () => { this.status = "invalid"; };
    switch (this.state) {
      case S.ExpectSolid:
        if (!this.tokenEquals(KW.solid) || !wasAtLineStart) return fail();
        if (endedByEol) {
          this.state = S.ExpectFacetOrEndsolid;
        } else {
          this.nameUtf8 = new Utf8Validator();
          this.state = S.SolidName;
        }
        break;
      case S.ExpectFacetOrEndsolid:
        if (this.tokenEquals(KW.facet)) {
          this.state = S.ExpectNormalKw;
        } else if (this.tokenEquals(KW.endsolid) && wasAtLineStart) {
          this.blocksSeen++;
          if (endedByEol) {
            this.state = S.ExpectSolid;
          } else {
            this.nameUtf8 = new Utf8Validator();
            this.state = S.EndName;
          }
        } else {
          return fail();
        }
        break;
      case S.ExpectNormalKw:
        if (!this.tokenEquals(KW.normal)) return fail();
        this.normalNumCount = 0;
        this.state = S.ExpectNormalNum;
        break;
      case S.ExpectNormalNum: {
        if (this.parseNumberToken() === null) return fail();
        this.normalNumCount++;
        if (this.normalNumCount === 3) this.state = S.ExpectOuter;
        break;
      }
      case S.ExpectOuter:
        if (!this.tokenEquals(KW.outer)) return fail();
        this.state = S.ExpectLoop;
        break;
      case S.ExpectLoop:
        if (!this.tokenEquals(KW.loop)) return fail();
        this.vertexCount = 0;
        this.state = S.ExpectVertexKw;
        break;
      case S.ExpectVertexKw:
        if (!this.tokenEquals(KW.vertex)) return fail();
        this.vertexNumCount = 0;
        this.state = S.ExpectVertexNum;
        break;
      case S.ExpectVertexNum: {
        const v = this.parseNumberToken();
        if (v === null) return fail();
        const axis = this.vertexNumCount;
        if (v < this.min[axis]!) this.min[axis] = v;
        if (v > this.max[axis]!) this.max[axis] = v;
        this.vertexNumCount++;
        if (this.vertexNumCount === 3) {
          this.vertexCount++;
          this.state = this.vertexCount < 3 ? S.ExpectVertexKw : S.ExpectEndloop;
        }
        break;
      }
      case S.ExpectEndloop:
        if (!this.tokenEquals(KW.endloop)) return fail();
        this.state = S.ExpectEndfacet;
        break;
      case S.ExpectEndfacet:
        if (!this.tokenEquals(KW.endfacet)) return fail();
        this.triangles++;
        this.state = S.ExpectFacetOrEndsolid;
        break;
      default:
        return fail();
    }
    this.tokenLen = 0;
  }

  finish(): void {
    if (this.status !== "pending") return;
    if (this.tokenLen > 0) {
      const wasAtLineStart = this.atLineStart;
      this.flushToken(true, wasAtLineStart);
      if (this.status !== "pending") return;
    }
    if (this.state === S.SolidName) {
      // File ended inside a solid block: missing endsolid.
      this.status = "invalid";
      return;
    }
    if (this.state === S.EndName) {
      // Final endsolid line may end at EOF.
      if (!this.nameUtf8.isComplete()) {
        this.status = "invalid";
        return;
      }
      this.blocksSeen++;
      this.state = S.ExpectSolid;
    }
    this.status = this.state === S.ExpectSolid && this.blocksSeen >= 1 ? "done" : "invalid";
  }

  result(): AsciiParseResult {
    return {
      status: this.status,
      triangleCount: this.triangles,
      bboxMin: [this.min[0], this.min[1], this.min[2]],
      bboxMax: [this.max[0], this.max[1], this.max[2]],
    };
  }
}
