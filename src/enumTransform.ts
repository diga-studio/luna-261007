/**
 * 枚举精确匹配：仅当输入为字符串且与某个声明值完全相等（区分大小写，
 * 不做数字与字符串互转）时返回该字符串，否则返回 null。
 */
export function matchEnum(input: unknown, values: readonly string[]): string | null {
  if (typeof input !== "string") return null;
  for (const value of values) {
    if (input === value) return value;
  }
  return null;
}
