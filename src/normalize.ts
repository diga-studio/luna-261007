/**
 * 匹配语义（词条与评价一致）：
 * 1. 忽略 U+200B / U+2060 / U+FEFF；
 * 2. 以整段文字的 Unicode NFKC 结果为准；
 * 3. 将英文字母 A-Z 视同 a-z。
 *
 * 为了把标准化后的偏移映射回原文，实现上先剔除隐形字符，
 * 再按 Unicode 扩展字素簇分段、逐簇 NFKC——字素簇是最小高亮单位，
 * 因此映射只需精确到字素簇。
 */

const IGNORED_CODE_POINTS = new Set([0x200b, 0x2060, 0xfeff]);

export interface NormalizedText {
  /** 标准化后的文本 */
  normalized: string;
  /**
   * normalizedToOrigin[i] 给出 normalized 第 i 个 UTF-16 单元
   * 所属字素簇在原文中的区间 [start, end)（按 UTF-16 单元计）。
   */
  normalizedToOrigin: Array<{ start: number; end: number }>;
}

/** 剔除隐形字符，返回剩余文本及每个剩余 UTF-16 单元的原文下标 */
function stripInvisible(text: string): { filtered: string; originIndex: number[] } {
  let filtered = "";
  const originIndex: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (!IGNORED_CODE_POINTS.has(text.codePointAt(i)!)) {
      filtered += text[i];
      originIndex.push(i);
    }
  }
  return { filtered, originIndex };
}

function foldAsciiUpper(piece: string): string {
  return piece.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
}

export function buildNormalizedText(text: string): NormalizedText {
  const { filtered, originIndex } = stripInvisible(text);

  const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
  let normalized = "";
  const normalizedToOrigin: Array<{ start: number; end: number }> = [];

  for (const seg of segmenter.segment(filtered)) {
    const clusterStart = seg.index;
    const clusterEnd = seg.index + seg.segment.length;
    // 字素簇在原文中的区间：最左起点至最右终点（含内部被忽略的隐形字符）
    const originStart = originIndex[clusterStart];
    const originEnd = originIndex[clusterEnd - 1] + 1;

    const piece = foldAsciiUpper(filtered.slice(clusterStart, clusterEnd).normalize("NFKC"));
    for (let k = 0; k < piece.length; k++) {
      normalizedToOrigin.push({ start: originStart, end: originEnd });
    }
    normalized += piece;
  }

  return { normalized, normalizedToOrigin };
}

/** 词条侧的标准化：与评价完全同一管线，保证同一匹配语义 */
export function normalizeWord(text: string): string {
  return buildNormalizedText(text).normalized;
}
