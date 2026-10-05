import type { LineChange } from "./types";

/**
 * 计算一侧相对祖先的行级差异。
 * 删行与插行总数最少（LCS 最长保留）；并列时操作序列按
 * 保留 < 删除 < 插入 的优先顺序取字典序最小结果。
 * 连续的删除/插入合为一个改动，保留行隔开改动。
 */
export function diffLines(ancestor: readonly string[], side: readonly string[]): LineChange[] {
  const n = ancestor.length;
  const m = side.length;

  // lcs[i][j]：ancestor[i..] 与 side[j..] 的最长公共子序列长度。
  const lcs: number[][] = new Array<number[]>(n + 1);
  for (let i = 0; i <= n; i++) {
    lcs[i] = new Array<number>(m + 1).fill(0);
  }
  for (let i = n - 1; i >= 0; i--) {
    const row = lcs[i]!;
    const next = lcs[i + 1]!;
    for (let j = m - 1; j >= 0; j--) {
      if (ancestor[i] === side[j]) {
        row[j] = next[j + 1]! + 1;
      } else {
        row[j] = Math.max(next[j]!, row[j + 1]!);
      }
    }
  }

  // 回溯生成操作序列。每一步在仍可达最优解的操作中取优先级最高者：
  // 保留可行则保留，否则删除可行则删除，最后才插入。
  const changes: LineChange[] = [];
  let i = 0;
  let j = 0;
  let openStart = -1; // 当前未闭合改动在祖先中的起点
  let openEnd = -1; // 当前未闭合改动在祖先中的终点（不含）
  let openLines: string[] = []; // 当前未闭合改动的插入行

  const closeChange = (): void => {
    if (openStart !== -1) {
      changes.push({ start: openStart, end: openEnd, lines: openLines });
      openStart = -1;
      openEnd = -1;
      openLines = [];
    }
  };
  const ensureOpen = (at: number): void => {
    if (openStart === -1) {
      openStart = at;
      openEnd = at;
      openLines = [];
    }
  };

  while (i < n || j < m) {
    if (i < n && j < m && ancestor[i] === side[j]) {
      // 保留：相等行直接匹配必在最优解上，且优先级最高。
      closeChange();
      i++;
      j++;
    } else if (i < n && (j === m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      // 删除：删除后仍可达最优，且删除优先于插入。
      ensureOpen(i);
      openEnd = i + 1;
      i++;
    } else {
      // 插入。
      ensureOpen(i);
      openLines.push(side[j]!);
      j++;
    }
  }
  closeChange();
  return changes;
}
