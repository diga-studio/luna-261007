/** 按空白切分街道文本，仅忽略 ASCII 大小写与多余空白，保留标点。 */
export function tokenize(street: string): string[] {
  return street
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .map((token) => token.replace(/[A-Z]/g, (ch) => ch.toLowerCase()));
}
