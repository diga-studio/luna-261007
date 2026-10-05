/**
 * Randomized treap keyed by (eventTimeMs, recordId), one node per effective
 * record. Subtree augmentations (count/sum/min/max of value, plus min/max of
 * eventTimeMs) allow O(log n) expected-time range aggregate queries over
 * event time without scanning the records inside the range.
 */

export interface RangeAggregates {
  count: number;
  sum: number;
  min: number;
  max: number;
}

export const EMPTY_AGGREGATES: RangeAggregates = Object.freeze({
  count: 0,
  sum: 0,
  min: Infinity,
  max: -Infinity,
});

interface TreapNode {
  /** Primary sort key. */
  readonly time: number;
  /** Tiebreaker key; unique per record. */
  readonly id: string;
  readonly value: number;
  readonly priority: number;
  left: TreapNode | null;
  right: TreapNode | null;
  // Subtree augmentations.
  subCount: number;
  subSum: number;
  subMin: number;
  subMax: number;
  subMinTime: number;
  subMaxTime: number;
}

function compareKey(timeA: number, idA: string, timeB: number, idB: string): number {
  if (timeA !== timeB) return timeA < timeB ? -1 : 1;
  if (idA === idB) return 0;
  return idA < idB ? -1 : 1;
}

function pull(node: TreapNode): void {
  const left = node.left;
  const right = node.right;
  node.subCount = 1 + (left?.subCount ?? 0) + (right?.subCount ?? 0);
  node.subSum = node.value + (left?.subSum ?? 0) + (right?.subSum ?? 0);
  node.subMin = Math.min(node.value, left?.subMin ?? Infinity, right?.subMin ?? Infinity);
  node.subMax = Math.max(node.value, left?.subMax ?? -Infinity, right?.subMax ?? -Infinity);
  node.subMinTime = left ? left.subMinTime : node.time;
  node.subMaxTime = right ? right.subMaxTime : node.time;
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

export class TimestampIndex {
  private root: TreapNode | null = null;
  private nodeCount = 0;

  /** Insert one record contribution. (time, id) must not already exist. */
  add(eventTimeMs: number, recordId: string, value: number): void {
    this.root = this.insert(this.root, {
      time: eventTimeMs,
      id: recordId,
      value,
      priority: Math.random(),
      left: null,
      right: null,
      subCount: 0,
      subSum: 0,
      subMin: 0,
      subMax: 0,
      subMinTime: 0,
      subMaxTime: 0,
    });
    this.nodeCount += 1;
  }

  /** Remove one record contribution. (time, id) must exist. */
  remove(eventTimeMs: number, recordId: string): void {
    this.root = this.delete(this.root, eventTimeMs, recordId);
    this.nodeCount -= 1;
  }

  /** Aggregate over records with eventTimeMs in (lowerExclusive, upperInclusive]. */
  queryRange(lowerExclusive: number, upperInclusive: number): RangeAggregates {
    if (lowerExclusive >= upperInclusive || this.root === null) {
      return { ...EMPTY_AGGREGATES };
    }
    return this.queryNode(this.root, lowerExclusive, upperInclusive);
  }

  /** Number of indexed records. */
  get size(): number {
    return this.nodeCount;
  }

  private insert(node: TreapNode | null, fresh: TreapNode): TreapNode {
    if (node === null) {
      pull(fresh);
      return fresh;
    }
    if (compareKey(fresh.time, fresh.id, node.time, node.id) < 0) {
      node.left = this.insert(node.left, fresh);
      if (node.left !== null && node.left.priority > node.priority) {
        return rotateRight(node);
      }
    } else {
      node.right = this.insert(node.right, fresh);
      if (node.right !== null && node.right.priority > node.priority) {
        return rotateLeft(node);
      }
    }
    pull(node);
    return node;
  }

  private delete(node: TreapNode | null, time: number, id: string): TreapNode | null {
    if (node === null) {
      throw new Error(`record not indexed: (${time}, ${id})`);
    }
    const cmp = compareKey(time, id, node.time, node.id);
    if (cmp < 0) {
      node.left = this.delete(node.left, time, id);
      pull(node);
      return node;
    }
    if (cmp > 0) {
      node.right = this.delete(node.right, time, id);
      pull(node);
      return node;
    }
    // Found the node: rotate it down until it can be dropped as a leaf.
    if (node.left === null) return node.right;
    if (node.right === null) return node.left;
    if (node.left.priority > node.right.priority) {
      const rotated = rotateRight(node);
      rotated.right = this.delete(rotated.right, time, id);
      pull(rotated);
      return rotated;
    }
    const rotated = rotateLeft(node);
    rotated.left = this.delete(rotated.left, time, id);
    pull(rotated);
    return rotated;
  }

  private queryNode(node: TreapNode, lowerExclusive: number, upperInclusive: number): RangeAggregates {
    // Whole subtree outside the time range: prune.
    if (node.subMaxTime <= lowerExclusive || node.subMinTime > upperInclusive) {
      return { count: 0, sum: 0, min: Infinity, max: -Infinity };
    }
    // Whole subtree inside the time range: take the precomputed aggregates.
    if (node.subMinTime > lowerExclusive && node.subMaxTime <= upperInclusive) {
      return { count: node.subCount, sum: node.subSum, min: node.subMin, max: node.subMax };
    }
    let count = 0;
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    if (node.left !== null) {
      const left = this.queryNode(node.left, lowerExclusive, upperInclusive);
      count += left.count;
      sum += left.sum;
      if (left.min < min) min = left.min;
      if (left.max > max) max = left.max;
    }
    if (node.time > lowerExclusive && node.time <= upperInclusive) {
      count += 1;
      sum += node.value;
      if (node.value < min) min = node.value;
      if (node.value > max) max = node.value;
    }
    if (node.right !== null) {
      const right = this.queryNode(node.right, lowerExclusive, upperInclusive);
      count += right.count;
      sum += right.sum;
      if (right.min < min) min = right.min;
      if (right.max > max) max = right.max;
    }
    return { count, sum, min, max };
  }
}
