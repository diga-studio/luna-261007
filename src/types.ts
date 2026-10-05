/** 字段路径段：对象属性或数组通配（数组层级用 "*" 表示，最多一层）。 */
export type PathSegment = string;

/** 转换参数：copy 无参数；date / enum / unit 各自带参数。 */
export interface CopyTransform {
  readonly kind: "copy";
}

export interface DateTransform {
  readonly kind: "date";
}

export interface EnumTransform {
  readonly kind: "enum";
  /** 允许的取值，精确匹配、区分大小写。 */
  readonly values: readonly string[];
}

export interface UnitTransform {
  readonly kind: "unit";
  /** 倍率分子（整数，以十进制字符串表示，可为负）。 */
  readonly numerator: string;
  /** 倍率分母（正整数十进制字符串）。 */
  readonly denominator: string;
  /** 目标小数位，0-6。 */
  readonly scale: number;
}

export type Transform = CopyTransform | DateTransform | EnumTransform | UnitTransform;

/** 一条映射规则：源叶子 -> 目标叶子。 */
export interface MappingRule {
  /** 源字段路径，如 ["a", "b"]；数组层级用 "*" 段表示。 */
  readonly source: readonly PathSegment[];
  /** 目标字段路径。 */
  readonly target: readonly PathSegment[];
  readonly transform: Transform;
}

/** 整份映射定义。 */
export interface MappingDefinition {
  readonly rules: readonly MappingRule[];
}

/** 定义检查发现的冲突/非法项。 */
export interface DefinitionIssue {
  readonly ruleIndex: number;
  readonly message: string;
}

export type DefinitionCheckResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: readonly DefinitionIssue[] };

/** 单字段转换失败，可定位到记录、数组下标与目标字段。 */
export interface FieldError {
  /** 源记录在批次中的下标。 */
  readonly recordIndex: number;
  /** 数组元素下标；非数组路径为 null。 */
  readonly arrayIndex: number | null;
  /** 目标字段路径。 */
  readonly target: readonly PathSegment[];
  readonly message: string;
}

export interface RecordResult {
  /** 每条源记录恰好一条输出；记录级不失败。 */
  readonly output: unknown;
  readonly errors: readonly FieldError[];
}

export interface BatchResult {
  readonly records: readonly RecordResult[];
  /** 全部记录的错误汇总（与 records[i].errors 一致，便于调用方）。 */
  readonly errors: readonly FieldError[];
}
