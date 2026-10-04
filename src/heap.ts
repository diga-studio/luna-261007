/**
 * Max-heap of candidate positions ordered by (gain desc, id asc).
 * Gains are exact numbers (integer-valued), ids come from `ids`.
 */
export class GainHeap {
  private positions: Int32Array;
  private gains: Float64Array;
  private size = 0;

  constructor(
    capacity: number,
    private readonly ids: Uint32Array,
  ) {
    this.positions = new Int32Array(capacity);
    this.gains = new Float64Array(capacity);
  }

  get length(): number {
    return this.size;
  }

  /** ordering: higher gain first; ties broken by smaller id */
  private less(aPos: number, aGain: number, bPos: number, bGain: number): boolean {
    if (aGain !== bGain) return aGain < bGain;
    return this.ids[aPos] > this.ids[bPos];
  }

  push(pos: number, gain: number): void {
    let i = this.size++;
    this.positions[i] = pos;
    this.gains[i] = gain;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(this.positions[parent], this.gains[parent], this.positions[i], this.gains[i])) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  peekPos(): number {
    return this.positions[0];
  }

  peekGain(): number {
    return this.gains[0];
  }

  pop(): void {
    this.size--;
    if (this.size === 0) return;
    this.positions[0] = this.positions[this.size];
    this.gains[0] = this.gains[this.size];
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let best = i;
      if (l < this.size && this.less(this.positions[best], this.gains[best], this.positions[l], this.gains[l])) best = l;
      if (r < this.size && this.less(this.positions[best], this.gains[best], this.positions[r], this.gains[r])) best = r;
      if (best === i) break;
      this.swap(i, best);
      i = best;
    }
  }

  private swap(a: number, b: number): void {
    const tp = this.positions[a];
    this.positions[a] = this.positions[b];
    this.positions[b] = tp;
    const tg = this.gains[a];
    this.gains[a] = this.gains[b];
    this.gains[b] = tg;
  }
}
