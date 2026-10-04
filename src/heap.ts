/** 以创建序号为键的二叉最小堆，元素为报名 id。 */
export class MinHeap {
  private readonly items: number[] = [];
  private readonly keys = new Map<number, number>();

  get size(): number {
    return this.items.length;
  }

  /** 压入元素；key 必须唯一对应 item（重复压入由调用方用 inHeap 避免）。 */
  push(item: number, key: number): void {
    this.keys.set(item, key);
    this.items.push(item);
    this.siftUp(this.items.length - 1);
  }

  /** 弹出 key 最小的元素；空堆返回 undefined。 */
  pop(): number | undefined {
    const top = this.items[0];
    if (top === undefined) return undefined;
    const last = this.items.pop();
    this.keys.delete(top);
    if (last !== undefined && this.items.length > 0) {
      this.items[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  clear(): void {
    this.items.length = 0;
    this.keys.clear();
  }

  private keyOf(index: number): number {
    const item = this.items[index];
    const key = item === undefined ? undefined : this.keys.get(item);
    if (key === undefined) throw new Error("heap invariant broken");
    return key;
  }

  private siftUp(index: number): void {
    let child = index;
    while (child > 0) {
      const parent = (child - 1) >> 1;
      if (this.keyOf(parent) <= this.keyOf(child)) break;
      this.swap(parent, child);
      child = parent;
    }
  }

  private siftDown(index: number): void {
    let parent = index;
    const n = this.items.length;
    for (;;) {
      const left = parent * 2 + 1;
      const right = left + 1;
      let smallest = parent;
      if (left < n && this.keyOf(left) < this.keyOf(smallest)) smallest = left;
      if (right < n && this.keyOf(right) < this.keyOf(smallest)) smallest = right;
      if (smallest === parent) break;
      this.swap(parent, smallest);
      parent = smallest;
    }
  }

  private swap(a: number, b: number): void {
    const items = this.items;
    const tmp = items[a] as number;
    items[a] = items[b] as number;
    items[b] = tmp;
  }
}
