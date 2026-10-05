/** 把街道文本按空白切成词元，忽略 ASCII 大小写，保留标点。 */
export function tokenizeStreet(street: string): string[] {
  return street
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .map((token) => token.toLowerCase());
}
