/**
 * Generic ordered map keyed by integer minutes, backed by a treap.
 * Priorities are derived deterministically from the key (splitmix-style
 * hash), so the structure needs no external RNG state and behaves
 * identically across runs.
 */

export interface TreapEntry<V> {
  readonly key: number;
  readonly value: V;
}

interface Node<V> {
  key: number;
  value: V;
  priority: number;
  left: Node<V> | null;
  right: Node<V> | null;
}

/** Deterministic pseudo-random priority for a key (32-bit mix). */
function priorityOf(key: number): number {
  let z = (key | 0) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
  return (z ^ (z >>> 15)) >>> 0;
}

function rotateRight<V>(node: Node<V>): Node<V> {
  const child = node.left as Node<V>;
  node.left = child.right;
  child.right = node;
  return child;
}

function rotateLeft<V>(node: Node<V>): Node<V> {
  const child = node.right as Node<V>;
  node.right = child.left;
  child.left = node;
  return child;
}

function insertNode<V>(root: Node<V> | null, node: Node<V>): Node<V> {
  if (root === null) return node;
  if (node.key < root.key) {
    root.left = insertNode(root.left, node);
    if (root.left !== null && root.left.priority > root.priority) {
      return rotateRight(root);
    }
    return root;
  }
  root.right = insertNode(root.right, node);
  if (root.right !== null && root.right.priority > root.priority) {
    return rotateLeft(root);
  }
  return root;
}

function deleteNode<V>(root: Node<V> | null, key: number): Node<V> | null {
  if (root === null) return null;
  if (key < root.key) {
    root.left = deleteNode(root.left, key);
    return root;
  }
  if (key > root.key) {
    root.right = deleteNode(root.right, key);
    return root;
  }
  if (root.left === null) return root.right;
  if (root.right === null) return root.left;
  if (root.left.priority > root.right.priority) {
    const newRoot = rotateRight(root);
    newRoot.right = deleteNode(newRoot.right, key);
    return newRoot;
  }
  const newRoot = rotateLeft(root);
  newRoot.left = deleteNode(newRoot.left, key);
  return newRoot;
}

export class TreapMap<V> {
  private root: Node<V> | null = null;
  private count = 0;

  get size(): number {
    return this.count;
  }

  /** Insert or replace the value at `key`. */
  set(key: number, value: V): void {
    let node = this.root;
    while (node !== null) {
      if (key === node.key) {
        node.value = value;
        return;
      }
      node = key < node.key ? node.left : node.right;
    }
    this.root = insertNode(this.root, {
      key,
      value,
      priority: priorityOf(key),
      left: null,
      right: null,
    });
    this.count += 1;
  }

  /** Remove the entry at `key`; returns whether it existed. */
  delete(key: number): boolean {
    if (this.getNode(key) === null) return false;
    this.root = deleteNode(this.root, key);
    this.count -= 1;
    return true;
  }

  private getNode(key: number): Node<V> | null {
    let node = this.root;
    while (node !== null) {
      if (key === node.key) return node;
      node = key < node.key ? node.left : node.right;
    }
    return null;
  }

  /** Get the value stored at exactly `key`. */
  get(key: number): V | undefined {
    const node = this.getNode(key);
    return node === null ? undefined : node.value;
  }

  /** Entry with the greatest key <= `key`, or undefined if none. */
  floor(key: number): TreapEntry<V> | undefined {
    let node = this.root;
    let best: Node<V> | null = null;
    while (node !== null) {
      if (node.key === key) return node;
      if (node.key < key) {
        best = node;
        node = node.right;
      } else {
        node = node.left;
      }
    }
    return best === null ? undefined : best;
  }

  /** Entry with the smallest key >= `key`, or undefined if none. */
  lowerBound(key: number): TreapEntry<V> | undefined {
    let node = this.root;
    let best: Node<V> | null = null;
    while (node !== null) {
      if (node.key === key) return node;
      if (node.key < key) {
        node = node.right;
      } else {
        best = node;
        node = node.left;
      }
    }
    return best === null ? undefined : best;
  }

  /**
   * Append all entries with lo <= key < hi to `out`, in ascending key order.
   * Returns `out` for chaining.
   */
  collectRange(lo: number, hi: number, out: TreapEntry<V>[]): TreapEntry<V>[] {
    const stack: Node<V>[] = [];
    let node = this.root;
    // In-order traversal restricted to [lo, hi).
    for (;;) {
      while (node !== null) {
        if (node.key >= lo) {
          stack.push(node);
          node = node.left;
        } else {
          node = node.right;
        }
      }
      if (stack.length === 0) break;
      node = stack.pop() as Node<V>;
      if (node.key >= hi) break;
      out.push(node);
      node = node.right;
    }
    return out;
  }
}
