/**
 * Maximum bipartite matching primitives.
 * Left side: transaction ids. Right side: journal ids.
 */

/** Returns the size of a maximum matching in the given bipartite graph. */
export function maxMatchingSize(
  leftIds: readonly string[],
  rightIds: readonly string[],
  edges: readonly { left: string; right: string }[]
): number {
  const adjacency = new Map<string, string[]>();
  for (const id of leftIds) adjacency.set(id, []);
  for (const edge of edges) {
    const list = adjacency.get(edge.left);
    if (list) list.push(edge.right);
  }

  const matchRight = new Map<string, string>();

  const tryAugment = (
    left: string,
    visited: Set<string>
  ): boolean => {
    for (const right of adjacency.get(left) ?? []) {
      if (visited.has(right)) continue;
      visited.add(right);
      const current = matchRight.get(right);
      if (current === undefined || tryAugment(current, visited)) {
        matchRight.set(right, left);
        return true;
      }
    }
    return false;
  };

  let size = 0;
  for (const left of leftIds) {
    if (tryAugment(left, new Set())) size += 1;
  }
  return size;
}
