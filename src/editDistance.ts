/**
 * 判断两个码点数组的编辑距离是否恰好为 1。
 * 只允许插入、删除、替换；长度差大于 1 时直接为 false。
 */
export function isEditDistanceOne(a: string[], b: string[]): boolean {
  const la = a.length;
  const lb = b.length;
  if (la === lb) {
    let diff = 0;
    for (let i = 0; i < la; i++) {
      if (a[i] !== b[i]) {
        diff++;
        if (diff > 1) return false;
      }
    }
    return diff === 1;
  }
  if (la + 1 === lb) return isOneInsertion(a, b);
  if (lb + 1 === la) return isOneInsertion(b, a);
  return false;
}

/** b 是否恰好比 a 多一个码点（即 a 经一次插入得到 b）。 */
function isOneInsertion(shorter: string[], longer: string[]): boolean {
  const n = shorter.length;
  let i = 0;
  while (i < n && shorter[i] === longer[i]) i++;
  // 跳过长者的一个码点后，其余必须完全相等
  for (let j = i; j < n; j++) {
    if (shorter[j] !== longer[j + 1]) return false;
  }
  return true;
}
