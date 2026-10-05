import type { Hit } from "./types.js";

/**
 * Bounded min-heap keeping the exact top-k hits under the order
 * (score desc, id asc). The heap root is the *worst* retained hit, so
 * a candidate replaces it iff the candidate is strictly better.
 * This yields exact top-k without sorting all candidates.
 */
export class TopKHeap {
  private readonly capacity: number;
  private readonly ids: number[] = [];
  private readonly scores: number[] = [];

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  /** True when a is strictly worse than b under (score desc, id asc). */
  private worse(a: number, b: number): boolean {
    return (
      this.scores[a]! < this.scores[b]! ||
      (this.scores[a]! === this.scores[b]! && this.ids[a]! > this.ids[b]!)
    );
  }

  offer(id: number, score: number): void {
    if (this.ids.length < this.capacity) {
      this.ids.push(id);
      this.scores.push(score);
      this.siftUp(this.ids.length - 1);
    } else if (this.capacity > 0 && this.worseVirtual(0, id, score)) {
      // candidate (id, score) is better than the current worst
      this.ids[0] = id;
      this.scores[0] = score;
      this.siftDown(0);
    }
  }

  /** Compare index i against a virtual element (id, score). */
  private worseVirtual(i: number, id: number, score: number): boolean {
    return (
      this.scores[i]! < score ||
      (this.scores[i]! === score && this.ids[i]! > id)
    );
  }

  private siftUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.worse(i, parent)) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  private siftDown(i: number): void {
    for (;;) {
      const left = 2 * i + 1;
      const right = left + 1;
      let worst = i;
      if (left < this.ids.length && this.worse(left, worst)) worst = left;
      if (right < this.ids.length && this.worse(right, worst)) worst = right;
      if (worst === i) break;
      this.swap(i, worst);
      i = worst;
    }
  }

  private swap(a: number, b: number): void {
    const ti = this.ids[a]!;
    this.ids[a] = this.ids[b]!;
    this.ids[b] = ti;
    const ts = this.scores[a]!;
    this.scores[a] = this.scores[b]!;
    this.scores[b] = ts;
  }

  /** Hits sorted by score desc, then id asc. */
  sorted(): Hit[] {
    const out: Hit[] = [];
    for (let i = 0; i < this.ids.length; i++) {
      out.push({ id: this.ids[i]!, score: this.scores[i]! });
    }
    out.sort((a, b) => b.score - a.score || a.id - b.id);
    return out;
  }
}
