/** JSON 值类型（源记录与输出记录均由 JSON 值构成）。 */
export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

/** 字段路径段：对象属性或数组通配（数组层最多一层，用 "*" 表示逐元素映射）。 */
export type PathSegment = { kind: "prop"; name: string } | { kind: "array" };

/** 转换类型。 */
export type TransformKind = "date" | "enum" | "unit";

/** 日期转换参数：RFC3339(UTC 标记或数值偏移) -> UTC 固定 3 位小数秒。 */
export interface DateTransform {
  kind: "date";
}

/** 枚举转换参数：按声明值精确匹配（区分大小写，不做数字/字符串互转）。 */
export interface EnumTransform {
  kind: "enum";
  values: string[];
}

/** 单位换算参数：十进制字符串 * numerator / denominator，按 scale 位小数舍入（银行家舍入）。 */
export interface UnitTransform {
  kind: "unit";
  numerator: string;
  denominator: string;
  scale: number;
}

export type Transform = DateTransform | EnumTransform | UnitTransform;

/** 单条映射规则：源路径 -> 目标路径，可选一种转换；无转换表示原样复制。 */
export interface MappingRule {
  source: string;
  target: string;
  transform?: Transform;
}

/** 归一化定义：一组映射规则。 */
export interface MappingDefinition {
  rules: MappingRule[];
}

/** 定义检查错误。 */
export interface DefinitionError {
  code: string;
  message: string;
  ruleIndex?: number;
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: DefinitionError[] };

/** 单字段转换失败错误，可定位到源记录、数组下标与目标字段。 */
export interface FieldError {
  recordIndex: number;
  /** 源记录内数组下标（不涉及数组时为 null）。 */
  arrayIndex: number | null;
  sourcePath: string;
  targetPath: string;
  reason: string;
}

/** 批量转换结果：每条源记录恰好一条输出，顺序不变；失败字段逐条列出。 */
export interface ConvertResult {
  records: JsonObject[];
  errors: FieldError[];
}
