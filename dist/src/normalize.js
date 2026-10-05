"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IGNORED_CODE_POINTS = void 0;
exports.normalizeText = normalizeText;
exports.normalizeWithMap = normalizeWithMap;
/** 匹配语义：忽略 U+200B/U+2060/U+FEFF → 整段 NFKC → A-Z 视同 a-z */
exports.IGNORED_CODE_POINTS = [0x200b, 0x2060, 0xfeff];
const IGNORED_SET = new Set(exports.IGNORED_CODE_POINTS);
function isIgnored(char) {
    return IGNORED_SET.has(char.codePointAt(0));
}
function foldAsciiUpper(input) {
    return input.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
}
/** 词条/评价共用的标准化（不需要原文映射时使用） */
function normalizeText(input) {
    let stripped = "";
    for (const char of input) {
        if (!isIgnored(char)) {
            stripped += char;
        }
    }
    return foldAsciiUpper(stripped.normalize("NFKC"));
}
/** 评价文本标准化，并保留每个字素簇到原文的映射 */
function normalizeWithMap(input) {
    // 先剔除隐形字符，记录每个保留字符的原文区间
    const kept = [];
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
    const clusters = [];
    const parts = [];
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
