/** 匹配语义：忽略 U+200B/U+2060/U+FEFF → 整段 NFKC → A-Z 视同 a-z */
export const IGNORED_CODE_POINTS: readonly number[] = [0x200b, 0x2060, 0xfeff];

const IGNORED_SET: ReadonlySet<number> = new Set(IGNORED_CODE_POINTS);

/** 字素簇在原文与标准化文本中的对应关系 */
export interface ClusterMap {
  /** 原文起点（UTF-16 代码单元，含） */
  srcStart: number;
  /** 原文终点（UTF-16 代码单元，不含） */
  srcEnd: number;
  /** 标准化文本起点（UTF-16 代码单元，含） */
  normStart: number;
  /** 标准化文本终点（UTF-16 代码单元，不含） */
  normEnd: number;
}

export interface NormalizedText {
  text: string;
  clusters: ClusterMap[];
}

function isIgnored(char: string): boolean {
  return IGNORED_SET.has(char.codePointAt(0)!);
}

function foldAsciiUpper(input: string): string {
  return input.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
}

/** 词条/评价共用的标准化（不需要原文映射时使用） */
export function normalizeText(input: string): string {
  let stripped = "";
  for (const char of input) {
    if (!isIgnored(char)) {
      stripped += char;
    }
  }
  return foldAsciiUpper(stripped.normalize("NFKC"));
}

/** 评价文本标准化，并保留每个字素簇到原文的映射 */
export function normalizeWithMap(input: string): NormalizedText {
  // 先剔除隐形字符，记录每个保留字符的原文区间
  const kept: { char: string; srcStart: number; srcEnd: number }[] = [];
  let unitIndex = 0;
  for (const char of input) {
    const width = char.length;
    if (!isIgnored(char)) {
      kept.push({ char, srcStart: unitIndex, srcEnd: unitIndex + width });
    }
    unitIndex += width;
  }

  // 对剔除后的剩余文本切分扩展字素簇；簇的原文区间取成员最左起点至最右终点
  const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
  const strippedText = kept.map((k) => k.char).join("");
  const clusters: ClusterMap[] = [];
  const parts: string[] = [];
  let normOffset = 0;
  let keptIndex = 0;

  for (const segment of segmenter.segment(strippedText)) {
    const segStart = keptIndex;
    keptIndex += [...segment.segment].length;
    const segEnd = keptIndex;
    const srcStart = kept[segStart].srcStart;
    const srcEnd = kept[segEnd - 1].srcEnd;
    const normalized = foldAsciiUpper(segment.segment.normalize("NFKC"));
    clusters.push({ srcStart, srcEnd, normStart: normOffset, normEnd: normOffset + normalized.length });
    parts.push(normalized);
    normOffset += normalized.length;
  }

  return { text: parts.join(""), clusters };
}
