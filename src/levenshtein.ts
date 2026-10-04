/** 把字符串拆成 Unicode 码点数组（不按 UTF-16 代码单元）。 */
export function toCodePoints(s: string): string[] {
  return Array.from(s);
}

/**
 * 以 Unicode 码点为单位的编辑距离（插入/删除/替换单个码点，代价均为 1）。
 * 不做大小写、空格、标点的任何归一化。
 */
export function editDistance(a: string, b: string): number {
  const ca = toCodePoints(a);
  const cb = toCodePoints(b);
  const n = ca.length;
  const m = cb.length;
  if (n === 0) return m;
  if (m === 0) return n;
  let prev = new Uint32Array(m + 1);
  let curr = new Uint32Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    curr[0] = i;
    const ai = ca[i - 1]!;
    for (let j = 1; j <= m; j++) {
      const cost = ai === cb[j - 1] ? 0 : 1;
      const del = prev[j]! + 1;
      const ins = curr[j - 1]! + 1;
      const sub = prev[j - 1]! + cost;
      curr[j] = Math.min(del, ins, sub);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[m]!;
}

/**
 * 相似度 = 1 - d / max(lenA, lenB)；两句均为空时为 1，仅一句为空时为 0。
 * 长度按码点计。
 */
export function similarity(a: string, b: string): number {
  const lenA = toCodePoints(a).length;
  const lenB = toCodePoints(b).length;
  const maxLen = Math.max(lenA, lenB);
  if (maxLen === 0) return 1;
  return 1 - editDistance(a, b) / maxLen;
}
