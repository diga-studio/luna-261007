/**
 * A single change of `modified` relative to `ancestor`, in ancestor line
 * coordinates. `start` is the ancestor line index at which the change
 * begins; `deleteCount` ancestor lines are removed and `inserted` lines
 * take their place. A pure insertion has `deleteCount === 0` and sits
 * between ancestor lines (before line `start`).
 */
export interface Change {
  start: number;
  deleteCount: number;
  inserted: string[];
}

/**
 * Computes the difference between two line arrays as a list of changes.
 * The total number of deleted plus inserted lines is minimal; ties are
 * broken by preferring keep, then delete, then insert operations so the
 * operation sequence is lexicographically smallest.
 */
export function diffLines(ancestor: string[], modified: string[]): Change[] {
  const n = ancestor.length;
  const m = modified.length;

  // cost[i][j] = minimal number of delete+insert operations aligning
  // ancestor[i..n) with modified[j..m).
  const width = m + 1;
  const cost = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    cost[i * width + m] = n - i;
  }
  for (let j = m - 1; j >= 0; j--) {
    cost[n * width + j] = m - j;
  }
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      let best = cost[(i + 1) * width + j] + 1;
      const insertCost = cost[i * width + j + 1] + 1;
      if (insertCost < best) {
        best = insertCost;
      }
      if (ancestor[i] === modified[j]) {
        const keepCost = cost[(i + 1) * width + j + 1];
        if (keepCost < best) {
          best = keepCost;
        }
      }
      cost[i * width + j] = best;
    }
  }

  // Greedy walk: among cost-optimal moves prefer keep, then delete, then
  // insert, yielding the lexicographically smallest operation sequence.
  const changes: Change[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (
      i < n &&
      j < m &&
      ancestor[i] === modified[j] &&
      cost[i * width + j] === cost[(i + 1) * width + j + 1]
    ) {
      i++;
      j++;
      continue;
    }
    const change: Change = { start: i, deleteCount: 0, inserted: [] };
    while (i < n || j < m) {
      if (
        i < n &&
        j < m &&
        ancestor[i] === modified[j] &&
        cost[i * width + j] === cost[(i + 1) * width + j + 1]
      ) {
        break;
      }
      if (i < n && cost[i * width + j] === cost[(i + 1) * width + j] + 1) {
        change.deleteCount++;
        i++;
      } else {
        change.inserted.push(modified[j]);
        j++;
      }
    }
    changes.push(change);
  }
  return changes;
}
