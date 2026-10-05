/**
 * 列类型匹配器。所有匹配器均假定输入为 CSV 解码后的原文（不裁剪）。
 * 调用方须先用 hasEdgeWhitespace 排除首尾含 White_Space 的非空值，
 * 此类值只能匹配 text。
 */
/** 非空值首尾含 Unicode White_Space 时只能匹配 text。 */
export declare function hasEdgeWhitespace(value: string): boolean;
export declare function matchBoolean(value: string): boolean;
export declare function matchInteger(value: string): boolean;
export declare function matchFloat(value: string): boolean;
/** 严格 MM/DD/YYYY 的真实公历日期，年份 0001-9999。 */
export declare function matchDate(value: string): boolean;
export declare function matchUrl(value: string): boolean;
export declare function matchEmail(value: string): boolean;
