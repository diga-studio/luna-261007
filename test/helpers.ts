/** 断言值非空并返回之，用于收窄 ReadResult | null。 */
export function must<T>(value: T | null): T {
  if (value === null) {
    throw new Error('expected non-null result');
  }
  return value;
}
