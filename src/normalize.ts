/**
 * 等价规则：
 * - ASCII 字母不区分大小写（统一折叠为小写）；
 * - 全角 ASCII 字符（U+FF01..U+FF5E，以及全角空格 U+3000）等同对应半角字符；
 * - 忽略 U+200B、U+200C、U+200D、U+FEFF；
 * - 其余字符按字面保留。
 */

const FULLWIDTH_START = 0xff01;
const FULLWIDTH_END = 0xff5e;
const FULLWIDTH_OFFSET = 0xfee0;
const FULLWIDTH_SPACE = 0x3000;
const HALF_SPACE = 0x20;

/** 对单个 Unicode 码点做等价变换；返回 null 表示该码点被忽略。 */
export function normalizeCodePoint(cp: number): number | null {
  if (cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0xfeff) {
    return null;
  }
  if (cp === FULLWIDTH_SPACE) {
    return HALF_SPACE;
  }
  if (cp >= FULLWIDTH_START && cp <= FULLWIDTH_END) {
    cp = cp - FULLWIDTH_OFFSET;
  }
  if (cp >= 0x41 && cp <= 0x5a) {
    cp = cp + 0x20;
  }
  return cp;
}

/** 归一化整段文本（词语用），返回归一化后的字符串。 */
export function normalizeWord(word: string): string {
  let out = "";
  for (const ch of word) {
    const cp = normalizeCodePoint(ch.codePointAt(0)!);
    if (cp !== null) {
      out += String.fromCodePoint(cp);
    }
  }
  return out;
}

export interface TextAnalysis {
  /** 原文的 UTF-8 字节数。 */
  readonly utf8Bytes: number;
  /**
   * 是否需要位置映射：文本含需变换/忽略的字符，或含补充平面字符
   * （此时归一化码点下标与原文 UTF-16 下标不一致）。
   */
  readonly needsMap: boolean;
}

/** 一遍扫描计算 UTF-8 字节数并判断是否需要位置映射。 */
export function analyzeText(text: string): TextAnalysis {
  let utf8Bytes = 0;
  let needsMap = false;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    utf8Bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (!needsMap && (cp > 0xffff || normalizeCodePoint(cp) !== cp)) {
      needsMap = true;
    }
  }
  return { utf8Bytes, needsMap };
}

/**
 * 以生成器形式产出归一化后的码点序列，同时把每个产出码点对应
 * 原文字符的 UTF-16 起始下标写入 scratch[count]。调用方按产出顺序
 * 消费，因此命中回调发生时相关映射项已就绪。不分配归一化字符串。
 */
export function* normalizedCodePoints(text: string, scratch: Uint32Array): Generator<number> {
  let count = 0;
  let i = 0;
  for (const ch of text) {
    const ncp = normalizeCodePoint(ch.codePointAt(0)!);
    if (ncp !== null) {
      scratch[count++] = i;
      yield ncp;
    }
    i += ch.length;
  }
}

export interface NormalizedText {
  /** 归一化后的文本，以 Unicode 码点为单位按下标访问。 */
  readonly normalized: string;
  /**
   * map[i] 是 normalized 第 i 个码点对应原文字符的 UTF-16 起始下标。
   * 为 null 表示恒等映射（文本不含需变换/忽略的字符，也不含补充平面字符）。
   */
  readonly map: Uint32Array | null;
}

/** 归一化待审文本并给出完整位置映射（测试与参考实现用）。 */
export function normalizeText(text: string): NormalizedText {
  if (!analyzeText(text).needsMap) {
    return { normalized: text, map: null };
  }
  const scratch = new Uint32Array(text.length);
  let normalized = "";
  let count = 0;
  for (const cp of normalizedCodePoints(text, scratch)) {
    normalized += String.fromCodePoint(cp);
    count++;
  }
  return { normalized, map: scratch.subarray(0, count) };
}
