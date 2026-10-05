/** 匹配语义：忽略 U+200B/U+2060/U+FEFF → 整段 NFKC → A-Z 视同 a-z */
export declare const IGNORED_CODE_POINTS: readonly number[];
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
/** 词条/评价共用的标准化（不需要原文映射时使用） */
export declare function normalizeText(input: string): string;
/** 评价文本标准化，并保留每个字素簇到原文的映射 */
export declare function normalizeWithMap(input: string): NormalizedText;
