import type { BookLevel, Side } from './types';

/** 盘口中的挂单条目（内部可变结构） */
export interface BookEntry {
  orderId: string;
  side: Side;
  price: number;
  remaining: number;
  /** 进入盘口的先后顺序号，同价按此排序 */
  seq: number;
}

/**
 * 单侧订单簿：价格优先、同价按进入先后。
 * 买侧按价格降序、卖侧按价格升序排列价位。
 */
export class OrderBookSide {
  /** 价位 -> 该价位挂单（按进入先后追加） */
  private readonly byPrice = new Map<number, BookEntry[]>();
  /** 排序后的价位数组，最优价在 index 0 */
  private prices: number[] = [];
  private readonly byId = new Map<string, BookEntry>();

  constructor(public readonly side: Side) {}

  /** 买侧价格高的更优，卖侧价格低的更优 */
  private better(a: number, b: number): boolean {
    return this.side === 'buy' ? a > b : a < b;
  }

  add(entry: BookEntry): void {
    let level = this.byPrice.get(entry.price);
    if (!level) {
      level = [];
      this.byPrice.set(entry.price, level);
      // 二分插入，保持 prices 按“最优在前”排序
      let lo = 0;
      let hi = this.prices.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.better(this.prices[mid]!, entry.price)) lo = mid + 1;
        else hi = mid;
      }
      this.prices.splice(lo, 0, entry.price);
    }
    level.push(entry);
    this.byId.set(entry.orderId, entry);
  }

  remove(orderId: string): BookEntry | null {
    const entry = this.byId.get(orderId);
    if (!entry) return null;
    this.byId.delete(orderId);
    const level = this.byPrice.get(entry.price)!;
    const idx = level.indexOf(entry);
    if (idx >= 0) level.splice(idx, 1);
    if (level.length === 0) {
      this.byPrice.delete(entry.price);
      const pidx = this.prices.indexOf(entry.price);
      if (pidx >= 0) this.prices.splice(pidx, 1);
    }
    return entry;
  }

  /** 最优价挂单（买侧最高价 / 卖侧最低价），无则 null */
  best(): BookEntry | null {
    if (this.prices.length === 0) return null;
    const level = this.byPrice.get(this.prices[0]!)!;
    return level[0] ?? null;
  }

  /** 从最优价开始按撮合顺序迭代 */
  *iterateBestFirst(): IterableIterator<BookEntry> {
    for (const price of this.prices) {
      const level = this.byPrice.get(price)!;
      for (const entry of level) yield entry;
    }
  }

  levels(): BookLevel[] {
    const out: BookLevel[] = [];
    for (const price of this.prices) {
      const level = this.byPrice.get(price)!;
      let total = 0;
      for (const e of level) total += e.remaining;
      out.push({ price, totalQuantity: total, orderCount: level.length });
    }
    return out;
  }

  get isEmpty(): boolean {
    return this.prices.length === 0;
  }
}
