import { OrderBook } from "./book.js";
import type {
  BookLevel,
  OrderStatus,
  OrderType,
  OrderView,
  Side,
  SubmitOrderRequest,
  SubmitResult,
  Trade,
  TriggerEvent,
} from "./types.js";

interface InternalOrder {
  id: number;
  type: OrderType;
  side: Side;
  /** 限价（市价单为 null） */
  price: number | null;
  /** 触发价（非止损单为 null） */
  stopPrice: number | null;
  quantity: number;
  remaining: number;
  status: OrderStatus;
}

function assertPositiveInt(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${value}`);
  }
}

/** 单交易对撮合引擎，订单簿与成交状态全部保存在进程内存中 */
export class MatchingEngine {
  private bids = new OrderBook("buy");
  private asks = new OrderBook("sell");
  private orders = new Map<number, InternalOrder>();
  /** 休眠中的止损买单：按触发价降序，队尾为最小触发价 */
  private buyStops: InternalOrder[] = [];
  /** 休眠中的止损卖单：按触发价升序，队尾为最大触发价 */
  private sellStops: InternalOrder[] = [];
  private nextOrderId = 1;
  private nextTradeId = 1;
  private nextSeq = 1;
  private lastPrice: number | null = null;

  submit(req: SubmitOrderRequest): SubmitResult {
    const order = this.validate(req);
    this.orders.set(order.id, order);

    const trades: Trade[] = [];
    const triggers: TriggerEvent[] = [];
    /** 已触发、等待按提交先后处理的订单 */
    const queue: InternalOrder[] = [];

    if (order.type === "stop_limit") {
      if (this.lastPrice !== null && this.stopConditionMet(order, this.lastPrice)) {
        // 提交时已有成交价且满足条件：立即激活
        triggers.push(this.fireTrigger(order, this.lastPrice));
        queue.push(order);
      } else {
        this.sleep(order);
        return { orderId: order.id, trades, triggers };
      }
    } else {
      queue.push(order);
    }

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.status === "sleeping") current.status = "open";
      this.match(current, trades, (price) => {
        // 每一笔成交都判断触发；同一笔成交触发的按最初提交先后排队
        const fired = this.collectTriggered(price);
        for (const o of fired) {
          triggers.push(this.fireTrigger(o, price));
          queue.push(o);
        }
      });
    }

    return { orderId: order.id, trades, triggers };
  }

  cancel(orderId: number): boolean {
    const order = this.orders.get(orderId);
    if (order === undefined) return false;
    if (order.status === "sleeping") {
      order.status = "canceled";
      this.removeSleeping(order);
      return true;
    }
    if (order.status === "open") {
      const book = order.side === "buy" ? this.bids : this.asks;
      if (book.remove(orderId) === null) return false;
      order.status = "canceled";
      return true;
    }
    return false;
  }

  /** 盘口深度：bids 按价格降序，asks 按价格升序 */
  depth(levels?: number): { bids: BookLevel[]; asks: BookLevel[] } {
    const bids = this.bids.levels();
    const asks = this.asks.levels();
    if (levels === undefined) return { bids, asks };
    return { bids: bids.slice(0, levels), asks: asks.slice(0, levels) };
  }

  orderStatus(orderId: number): OrderView | null {
    const o = this.orders.get(orderId);
    if (o === undefined) return null;
    return {
      orderId: o.id,
      type: o.type,
      side: o.side,
      price: o.price,
      stopPrice: o.stopPrice,
      quantity: o.quantity,
      filledQuantity: o.quantity - o.remaining,
      remainingQuantity: o.remaining,
      status: o.status,
    };
  }

  lastTradePrice(): number | null {
    return this.lastPrice;
  }

  private validate(req: SubmitOrderRequest): InternalOrder {
    assertPositiveInt(req.quantity, "quantity");
    let price: number | null = null;
    let stopPrice: number | null = null;
    if (req.type === "limit" || req.type === "stop_limit") {
      if (req.price === undefined) throw new Error(`${req.type} order requires price`);
      assertPositiveInt(req.price, "price");
      price = req.price;
    }
    if (req.type === "stop_limit") {
      if (req.stopPrice === undefined) throw new Error("stop_limit order requires stopPrice");
      assertPositiveInt(req.stopPrice, "stopPrice");
      stopPrice = req.stopPrice;
    }
    return {
      id: this.nextOrderId++,
      type: req.type,
      side: req.side,
      price,
      stopPrice,
      quantity: req.quantity,
      remaining: req.quantity,
      status: "open",
    };
  }

  /** 止损单激活后按普通限价单撮合；市价单余量撤销，限价单余量挂单 */
  private match(
    taker: InternalOrder,
    trades: Trade[],
    onTrade: (price: number) => void,
  ): void {
    const book = taker.side === "buy" ? this.asks : this.bids;
    while (taker.remaining > 0) {
      const maker = book.best();
      if (maker === null) break;
      if (taker.price !== null) {
        // 限价单不得以比自身限价更差的价格成交
        const ok = taker.side === "buy" ? maker.price <= taker.price : maker.price >= taker.price;
        if (!ok) break;
      }
      const qty = Math.min(taker.remaining, maker.remaining);
      taker.remaining -= qty;
      maker.remaining -= qty;
      trades.push({
        tradeId: this.nextTradeId++,
        price: maker.price, // 成交价取被动挂单价
        quantity: qty,
        makerOrderId: maker.orderId,
        takerOrderId: taker.id,
      });
      if (maker.remaining === 0) {
        book.remove(maker.orderId);
        const makerOrder = this.orders.get(maker.orderId)!;
        makerOrder.remaining = 0;
        makerOrder.status = "filled";
      } else {
        this.orders.get(maker.orderId)!.remaining = maker.remaining;
      }
      this.lastPrice = maker.price;
      onTrade(maker.price);
    }
    if (taker.remaining === 0) {
      taker.status = "filled";
    } else if (taker.price === null) {
      // 市价单没有可成交对手时撤销余量，不得挂单
      taker.status = "canceled";
    } else {
      taker.status = "open";
      const book2 = taker.side === "buy" ? this.bids : this.asks;
      book2.add({
        orderId: taker.id,
        side: taker.side,
        price: taker.price,
        remaining: taker.remaining,
        seq: this.nextSeq++,
      });
    }
  }

  private stopConditionMet(order: InternalOrder, lastPrice: number): boolean {
    // 买单：最新成交价 >= 触发价；卖单：最新成交价 <= 触发价
    return order.side === "buy"
      ? lastPrice >= order.stopPrice!
      : lastPrice <= order.stopPrice!;
  }

  private fireTrigger(order: InternalOrder, lastTradePrice: number): TriggerEvent {
    return { orderId: order.id, stopPrice: order.stopPrice!, lastTradePrice };
  }

  /** 收集某笔成交后新触发的休眠单，按最初提交先后排序 */
  private collectTriggered(price: number): InternalOrder[] {
    const fired: InternalOrder[] = [];
    while (this.buyStops.length > 0) {
      const top = this.buyStops[this.buyStops.length - 1]!;
      if (top.stopPrice! > price) break;
      fired.push(this.buyStops.pop()!);
    }
    while (this.sellStops.length > 0) {
      const top = this.sellStops[this.sellStops.length - 1]!;
      if (top.stopPrice! < price) break;
      fired.push(this.sellStops.pop()!);
    }
    fired.sort((a, b) => a.id - b.id);
    return fired;
  }

  private sleep(order: InternalOrder): void {
    order.status = "sleeping";
    const arr = order.side === "buy" ? this.buyStops : this.sellStops;
    // 买单按触发价降序、卖单按触发价升序插入，使队尾总是最接近触发的
    let lo = 0;
    let hi = arr.length;
    const sp = order.stopPrice!;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const m = arr[mid]!.stopPrice!;
      const before = order.side === "buy" ? m >= sp : m <= sp;
      if (before) lo = mid + 1;
      else hi = mid;
    }
    arr.splice(lo, 0, order);
  }

  private removeSleeping(order: InternalOrder): void {
    const arr = order.side === "buy" ? this.buyStops : this.sellStops;
    const idx = arr.indexOf(order);
    if (idx >= 0) arr.splice(idx, 1);
  }
}
