/**
 * 以 (seq, id) 字典序排序的最小堆，存放“可能已可录取”的候补 id。
 * 堆只是提示结构：弹出的条目必须重新完整校验，失效条目惰性丢弃。
 */
export class MinHeap {
  private seqs: number[] = [];
  private ids: number[] = [];

  get size(): number {
    return this.seqs.length;
  }

  push(seq: number, id: number): void {
    this.seqs.push(seq);
    this.ids.push(id);
    let i = this.seqs.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.less(i, parent)) {
        this.swap(i, parent);
        i = parent;
      } else {
        break;
      }
    }
  }

  peek(): { seq: number; id: number } | undefined {
    if (this.seqs.length === 0) return undefined;
    return { seq: this.seqs[0]!, id: this.ids[0]! };
  }

  pop(): { seq: number; id: number } | undefined {
    const n = this.seqs.length;
    if (n === 0) return undefined;
    const top = { seq: this.seqs[0]!, id: this.ids[0]! };
    const lastSeq = this.seqs.pop()!;
    const lastId = this.ids.pop()!;
    if (n > 1) {
      this.seqs[0] = lastSeq;
      this.ids[0] = lastId;
      let i = 0;
      for (;;) {
        const left = i * 2 + 1;
        const right = left + 1;
        let smallest = i;
        if (left < this.seqs.length && this.less(left, smallest)) smallest = left;
        if (right < this.seqs.length && this.less(right, smallest)) smallest = right;
        if (smallest === i) break;
        this.swap(i, smallest);
        i = smallest;
      }
    }
    return top;
  }

  private less(a: number, b: number): boolean {
    const sa = this.seqs[a]!;
    const sb = this.seqs[b]!;
    if (sa !== sb) return sa < sb;
    return this.ids[a]! < this.ids[b]!;
  }

  private swap(a: number, b: number): void {
    const ts = this.seqs[a]!;
    this.seqs[a] = this.seqs[b]!;
    this.seqs[b] = ts;
    const ti = this.ids[a]!;
    this.ids[a] = this.ids[b]!;
    this.ids[b] = ti;
  }
}
