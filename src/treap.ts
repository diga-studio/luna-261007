/**
 * Order-statistics treap keyed by (remainder, holderId).
 *
 * Ordering: larger remainder ranks first; ties broken by holder id in
 * ascending ASCII (lexicographic) order. Rank 1 is the "smallest" key in
 * this ordering, i.e. the largest remainder.
 *
 * Insert, erase and rankOf are expected O(log n) thanks to random
 * priorities. The structure stores no per-token records: one node per
 * holder with a positive balance.
 */

export interface TreapKey {
  readonly remainder: bigint;
  readonly id: string;
}

interface TreapNode {
  key: TreapKey;
  priority: number;
  size: number;
  left: TreapNode | null;
  right: TreapNode | null;
}

/** Compare two keys in rank order: remainder desc, then id asc. */
export function compareKeys(a: TreapKey, b: TreapKey): number {
  if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

function sizeOf(node: TreapNode | null): number {
  return node === null ? 0 : node.size;
}

function pull(node: TreapNode): void {
  node.size = 1 + sizeOf(node.left) + sizeOf(node.right);
}

function rotateRight(node: TreapNode): TreapNode {
  const child = node.left as TreapNode;
  node.left = child.right;
  child.right = node;
  pull(node);
  pull(child);
  return child;
}

function rotateLeft(node: TreapNode): TreapNode {
  const child = node.right as TreapNode;
  node.right = child.left;
  child.left = node;
  pull(node);
  pull(child);
  return child;
}

export class Treap {
  private root: TreapNode | null = null;
  private readonly nextPriority: () => number;

  constructor(random: () => number = Math.random) {
    this.nextPriority = random;
  }

  get size(): number {
    return sizeOf(this.root);
  }

  insert(key: TreapKey): void {
    const node: TreapNode = {
      key,
      priority: this.nextPriority(),
      size: 1,
      left: null,
      right: null,
    };
    this.root = this.insertNode(this.root, node);
  }

  erase(key: TreapKey): void {
    this.root = this.eraseKey(this.root, key);
  }

  /** 1-based rank of `key`; 0 if the key is absent. */
  rankOf(key: TreapKey): number {
    let node = this.root;
    let rank = 1;
    while (node !== null) {
      const cmp = compareKeys(key, node.key);
      if (cmp === 0) return rank + sizeOf(node.left);
      if (cmp < 0) {
        node = node.left;
      } else {
        rank += sizeOf(node.left) + 1;
        node = node.right;
      }
    }
    return 0;
  }

  /** Collect keys in rank order (used only by tests / diagnostics). */
  inOrder(): TreapKey[] {
    const out: TreapKey[] = [];
    const walk = (node: TreapNode | null): void => {
      if (node === null) return;
      walk(node.left);
      out.push(node.key);
      walk(node.right);
    };
    walk(this.root);
    return out;
  }

  private insertNode(root: TreapNode | null, node: TreapNode): TreapNode {
    if (root === null) return node;
    if (compareKeys(node.key, root.key) < 0) {
      root.left = this.insertNode(root.left, node);
      pull(root);
      return root.left.priority < root.priority ? rotateRight(root) : root;
    }
    root.right = this.insertNode(root.right, node);
    pull(root);
    return root.right.priority < root.priority ? rotateLeft(root) : root;
  }

  private eraseKey(root: TreapNode | null, key: TreapKey): TreapNode | null {
    if (root === null) return null;
    const cmp = compareKeys(key, root.key);
    if (cmp === 0) return this.merge(root.left, root.right);
    if (cmp < 0) {
      root.left = this.eraseKey(root.left, key);
    } else {
      root.right = this.eraseKey(root.right, key);
    }
    pull(root);
    return root;
  }

  private merge(left: TreapNode | null, right: TreapNode | null): TreapNode | null {
    if (left === null) return right;
    if (right === null) return left;
    if (left.priority < right.priority) {
      left.right = this.merge(left.right, right);
      pull(left);
      return left;
    }
    right.left = this.merge(left, right.left);
    pull(right);
    return right;
  }
}
