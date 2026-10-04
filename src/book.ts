import type { BookLevel, Side } from "./types.js";

/** 盘口中的挂单条目（内部可变） */
export interface BookEntry {
  orderId: number;
  side: Side;
  price: number;
  remaining: number;
  /** 进入盘口的递增序号，同价时间优先 */
  seq: number;
}

/** 单边普通盘口：价格优先、同价按进入盘口先后（FIFO） */
export class OrderBook {
  /** 有序价档：买单降序，卖单升序 */
  private prices: number[] = [];
  private levelsByPrice = new Map<number, BookEntry[]>();
  private byOrderId = new Map<number, BookEntry>();

  constructor(public readonly side: Side) {}

  private better(a: number, b: number): boolean {
    return this.side === "buy" ? a > b : a < b;
  }

  add(entry: BookEntry): void {
    let level = this.levelsByPrice.get(entry.price);
    if (level === undefined) {
      level = [];
      this.levelsByPrice.set(entry.price, level);
      // 二分插入保持 prices 有序
      let lo = 0;
      let hi = this.prices.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (this.prices[mid] === entry.price) break;
        if (this.better(entry.price, this.prices[mid]!)) hi = mid;
        else lo = mid + 1;
      }
      this.prices.splice(lo, 0, entry.price);
    }
    level.push(entry);
    this.byOrderId.set(entry.orderId, entry);
  }

  remove(orderId: number): BookEntry | null {
    const entry = this.byOrderId.get(orderId);
    if (entry === undefined) return null;
    this.byOrderId.delete(orderId);
    const level = this.levelsByPrice.get(entry.price)!;
    const idx = level.indexOf(entry);
    if (idx >= 0) level.splice(idx, 1);
    if (level.length === 0) {
      this.levelsByPrice.delete(entry.price);
      const pi = this.prices.indexOf(entry.price);
      if (pi >= 0) this.prices.splice(pi, 1);
    }
    return entry;
  }

  /** 最优价档队首订单 */
  best(): BookEntry | null {
    const price = this.bestPrice();
    if (price === null) return null;
    return this.levelsByPrice.get(price)![0] ?? null;
  }

  bestPrice(): number | null {
    return this.prices.length === 0 ? null : this.prices[0]!;
  }

  levels(): BookLevel[] {
    return this.prices.map((price) => {
      const level = this.levelsByPrice.get(price)!;
      let total = 0;
      for (const e of level) total += e.remaining;
      return { price, totalQuantity: total, orderCount: level.length };
    });
  }

  get size(): number {
    return this.byOrderId.size;
  }
}
