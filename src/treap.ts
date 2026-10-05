/**
 * Randomized treap keyed by (eventTimeMs, recordId), augmented with subtree
 * aggregates (count, sum, min, max) so that any event-time range can be
 * aggregated in O(log n) without scanning the records inside the range.
 *
 * The recordId tiebreaker makes keys unique even when many records share the
 * same eventTimeMs, so same-timestamp records are counted individually.
 */

export interface RangeStats {
  count: number;
  sum: number;
  min: number | null;
  max: number | null;
}

interface Node {
  t: number;
  id: string;
  value: number;
  prio: number;
  left: Node | null;
  right: Node | null;
  count: number;
  sum: number;
  min: number;
  max: number;
}

function pull(n: Node): void {
  let count = 1;
  let sum = n.value;
  let min = n.value;
  let max = n.value;
  if (n.left) {
    count += n.left.count;
    sum += n.left.sum;
    if (n.left.min < min) min = n.left.min;
    if (n.left.max > max) max = n.left.max;
  }
  if (n.right) {
    count += n.right.count;
    sum += n.right.sum;
    if (n.right.min < min) min = n.right.min;
    if (n.right.max > max) max = n.right.max;
  }
  n.count = count;
  n.sum = sum;
  n.min = min;
  n.max = max;
}

function cmp(t1: number, id1: string, t2: number, id2: string): number {
  if (t1 !== t2) return t1 < t2 ? -1 : 1;
  if (id1 === id2) return 0;
  return id1 < id2 ? -1 : 1;
}

function rotateRight(n: Node): Node {
  const l = n.left as Node;
  n.left = l.right;
  l.right = n;
  pull(n);
  pull(l);
  return l;
}

function rotateLeft(n: Node): Node {
  const r = n.right as Node;
  n.right = r.left;
  r.left = n;
  pull(n);
  pull(r);
  return r;
}

/** mulberry32: small deterministic PRNG for treap priorities. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Treap {
  private root: Node | null = null;
  private readonly rand: () => number;

  constructor(seed = 0x9e3779b9) {
    this.rand = makeRng(seed);
  }

  get size(): number {
    return this.root ? this.root.count : 0;
  }

  insert(t: number, id: string, value: number): void {
    const node: Node = {
      t, id, value,
      prio: this.rand(),
      left: null, right: null,
      count: 1, sum: value, min: value, max: value,
    };
    this.root = this.insertNode(this.root, node);
  }

  private insertNode(cur: Node | null, node: Node): Node {
    if (!cur) return node;
    if (cmp(node.t, node.id, cur.t, cur.id) < 0) {
      cur.left = this.insertNode(cur.left, node);
      const res = cur.left.prio < cur.prio ? rotateRight(cur) : cur;
      if (res === cur) pull(cur);
      return res;
    }
    cur.right = this.insertNode(cur.right, node);
    const res = cur.right.prio < cur.prio ? rotateLeft(cur) : cur;
    if (res === cur) pull(cur);
    return res;
  }

  remove(t: number, id: string): void {
    this.root = this.removeNode(this.root, t, id);
  }

  private removeNode(cur: Node | null, t: number, id: string): Node | null {
    if (!cur) return null;
    const c = cmp(t, id, cur.t, cur.id);
    if (c < 0) {
      cur.left = this.removeNode(cur.left, t, id);
      pull(cur);
      return cur;
    }
    if (c > 0) {
      cur.right = this.removeNode(cur.right, t, id);
      pull(cur);
      return cur;
    }
    return this.merge(cur.left, cur.right);
  }

  private merge(a: Node | null, b: Node | null): Node | null {
    if (!a) return b;
    if (!b) return a;
    if (a.prio < b.prio) {
      a.right = this.merge(a.right, b);
      pull(a);
      return a;
    }
    b.left = this.merge(a, b.left);
    pull(b);
    return b;
  }

  /** Aggregate over all keys with loExclusive < eventTimeMs <= hiInclusive. */
  rangeStats(loExclusive: number, hiInclusive: number): RangeStats {
    const acc: RangeStats = { count: 0, sum: 0, min: null, max: null };
    this.rangeInto(this.root, loExclusive, hiInclusive, acc);
    return acc;
  }

  private rangeInto(
    n: Node | null,
    lo: number,
    hi: number,
    acc: RangeStats,
  ): void {
    if (!n) return;
    if (n.t <= lo) {
      this.rangeInto(n.right, lo, hi, acc);
      return;
    }
    if (n.t > hi) {
      this.rangeInto(n.left, lo, hi, acc);
      return;
    }
    // lo < n.t <= hi: node is inside; descend both sides, absorbing whole
    // subtrees that lie fully within the range.
    this.absorbLeft(n.left, lo, acc);
    acc.count += 1;
    acc.sum += n.value;
    if (acc.min === null || n.value < acc.min) acc.min = n.value;
    if (acc.max === null || n.value > acc.max) acc.max = n.value;
    this.absorbRight(n.right, hi, acc);
  }

  /** Left boundary walk: keys in subtree are all < parent key; keep those > lo. */
  private absorbLeft(n: Node | null, lo: number, acc: RangeStats): void {
    if (!n) return;
    if (n.t <= lo) {
      this.absorbLeft(n.right, lo, acc);
      return;
    }
    // n.t > lo: n and its whole right subtree are in range; recurse left.
    this.absorbLeft(n.left, lo, acc);
    this.addNode(n, acc);
    if (n.right) this.addSubtree(n.right, acc);
  }

  /** Right boundary walk: keys in subtree are all > parent key; keep those <= hi. */
  private absorbRight(n: Node | null, hi: number, acc: RangeStats): void {
    if (!n) return;
    if (n.t > hi) {
      this.absorbRight(n.left, hi, acc);
      return;
    }
    // n.t <= hi: n and its whole left subtree are in range; recurse right.
    if (n.left) this.addSubtree(n.left, acc);
    this.addNode(n, acc);
    this.absorbRight(n.right, hi, acc);
  }

  private addNode(n: Node, acc: RangeStats): void {
    acc.count += 1;
    acc.sum += n.value;
    if (acc.min === null || n.value < acc.min) acc.min = n.value;
    if (acc.max === null || n.value > acc.max) acc.max = n.value;
  }

  private addSubtree(n: Node, acc: RangeStats): void {
    acc.count += n.count;
    acc.sum += n.sum;
    if (acc.min === null || n.min < acc.min) acc.min = n.min;
    if (acc.max === null || n.max > acc.max) acc.max = n.max;
  }
}
