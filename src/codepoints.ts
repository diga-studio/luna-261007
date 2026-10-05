/** 将字符串拆成 Unicode 码点数组（不按 UTF-16 代码单元拆分）。 */
export function toCodePoints(text: string): number[] {
  return Array.from(text, (ch) => ch.codePointAt(0)!);
}

/** 将码点数组还原为字符串。 */
export function fromCodePoints(codePoints: readonly number[]): string {
  return String.fromCodePoint(...codePoints);
}
