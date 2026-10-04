import { OrderBookSide } from './orderbook';
import type {
  BookSnapshot,
  OrderRequest,
  OrderStatus,
  OrderType,
  OrderView,
  Side,
  SubmitResult,
  Trade,
  TriggerEvent,
} from './types';

/** 引擎内部的订单记录 */
interface InternalOrder {
  id: string;
  side: Side;
  type: OrderType;
  price: number | null;
  stopPrice: number | null;
  quantity: number;
  filled: number;
  status: OrderStatus;
  /** 提交先后序号，止损触发批次内按此排序 */
  submitSeq: number;
}

function assertPositiveInt(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

/**
 * 单交易对撮合引擎。
 * 订单簿、休眠止损单、成交序号与最新成交价全部保存在进程内存中。
 */
export class MatchingEngine {
  private readonly bids = new OrderBookSide('buy');
  private readonly asks = new OrderBookSide('sell');
  private readonly orders = new Map<string, InternalOrder>();
  /** 休眠止损买单：最新成交价 >= 触发价时激活 */
  private readonly sleepingBuyStops = new Map<string, InternalOrder>();
  /** 休眠止损卖单：最新成交价 <= 触发价时激活 */
  private readonly sleepingSellStops = new Map<string, InternalOrder>();

  private tradeSeq = 0;
  private submitSeq = 0;
  private bookSeq = 0;
  private lastPrice: number | null = null;

  /** 本次提交期间累计的成交与触发记录 */
  private trades: Trade[] = [];
  private triggers: TriggerEvent[] = [];
  /** 已触发、等待按序处理的止损单（FIFO） */
  private triggerQueue: InternalOrder[] = [];

  submitOrder(req: OrderRequest): SubmitResult {
    const order = this.createOrder(req);
    this.trades = [];
    this.triggers = [];
    this.triggerQueue = [];

    if (order.type === 'stop_limit' && !this.stopConditionMet(order)) {
      // 尚无成交价或条件不满足：休眠，不进入普通盘口
      order.status = 'sleeping';
      this.sleepingStops(order.side).set(order.id, order);
      return { trades: [], triggers: [], order: this.view(order) };
    }

    if (order.type === 'stop_limit') {
      // 提交时已有成交价且满足条件：立即激活
      this.triggers.push({
        orderId: order.id,
        byTradeSeq: null,
        price: this.lastPrice!,
      });
    }

    this.processOrder(order);
    this.drainTriggerQueue();

    return {
      trades: this.trades,
      triggers: this.triggers,
      order: this.view(order),
    };
  }

  cancelOrder(orderId: string): OrderView {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`unknown order: ${orderId}`);
    if (order.status === 'open') {
      this.bookOf(order.side).remove(order.id);
      order.status = 'canceled';
    } else if (order.status === 'sleeping') {
      this.sleepingStops(order.side).delete(order.id);
      order.status = 'canceled';
    }
    // filled / canceled：已发生的成交保持不变，无可撤余量
    return this.view(order);
  }

  getOrder(orderId: string): OrderView | null {
    const order = this.orders.get(orderId);
    return order ? this.view(order) : null;
  }

  getBook(depth?: number): BookSnapshot {
    const asks = this.asks.levels();
    const bids = this.bids.levels();
    return {
      asks: depth === undefined ? asks : asks.slice(0, depth),
      bids: depth === undefined ? bids : bids.slice(0, depth),
    };
  }

  /** 最新成交价，尚无成交时为 null */
  get lastTradePrice(): number | null {
    return this.lastPrice;
  }

  // ---------- 内部实现 ----------

  private createOrder(req: OrderRequest): InternalOrder {
    if (this.orders.has(req.id)) {
      throw new Error(`duplicate order id: ${req.id}`);
    }
    assertPositiveInt(req.quantity, 'quantity');
    if (req.type === 'limit' || req.type === 'stop_limit') {
      if (req.price === undefined) throw new Error('price is required');
      assertPositiveInt(req.price, 'price');
    }
    if (req.type === 'stop_limit') {
      if (req.stopPrice === undefined) {
        throw new Error('stopPrice is required');
      }
      assertPositiveInt(req.stopPrice, 'stopPrice');
    }
    const order: InternalOrder = {
      id: req.id,
      side: req.side,
      type: req.type,
      price: req.price ?? null,
      stopPrice: req.stopPrice ?? null,
      quantity: req.quantity,
      filled: 0,
      status: 'open',
      submitSeq: ++this.submitSeq,
    };
    this.orders.set(order.id, order);
    return order;
  }

  private bookOf(side: Side): OrderBookSide {
    return side === 'buy' ? this.bids : this.asks;
  }

  private sleepingStops(side: Side): Map<string, InternalOrder> {
    return side === 'buy' ? this.sleepingBuyStops : this.sleepingSellStops;
  }

  private stopConditionMet(order: InternalOrder): boolean {
    if (this.lastPrice === null) return false;
    return order.side === 'buy'
      ? this.lastPrice >= order.stopPrice!
      : this.lastPrice <= order.stopPrice!;
  }

  /**
   * 把一笔订单撮合到全部成交、余量挂单或余量撤销为止。
   * 期间产生的触发记录追加到 triggerQueue，不在此处处理。
   */
  private processOrder(taker: InternalOrder): void {
    const book = this.bookOf(taker.side === 'buy' ? 'sell' : 'buy');
    while (taker.filled < taker.quantity) {
      const makerEntry = book.best();
      if (!makerEntry) break;
      if (!this.priceAcceptable(taker, makerEntry.price)) break;

      const maker = this.orders.get(makerEntry.orderId)!;
      const qty = Math.min(taker.quantity - taker.filled, makerEntry.remaining);
      const price = makerEntry.price;

      taker.filled += qty;
      maker.filled += qty;
      makerEntry.remaining -= qty;
      if (makerEntry.remaining === 0) {
        book.remove(makerEntry.orderId);
        maker.status = 'filled';
      }

      this.tradeSeq += 1;
      this.lastPrice = price;
      this.trades.push({
        seq: this.tradeSeq,
        takerOrderId: taker.id,
        makerOrderId: maker.id,
        price,
        quantity: qty,
      });
      this.collectTriggers(this.tradeSeq, price);
    }

    if (taker.filled === taker.quantity) {
      taker.status = 'filled';
    } else if (taker.type === 'market') {
      // 市价单余量不得挂单，直接撤销
      taker.status = 'canceled';
    } else {
      // 限价单 / 已激活止损限价单：余量进入盘口
      taker.status = 'open';
      this.bookOf(taker.side).add({
        orderId: taker.id,
        side: taker.side,
        price: taker.price!,
        remaining: taker.quantity - taker.filled,
        seq: ++this.bookSeq,
      });
    }
  }

  /** 限价类订单不得以比自身限价更差的价格成交；市价单不设限 */
  private priceAcceptable(taker: InternalOrder, makerPrice: number): boolean {
    if (taker.type === 'market') return true;
    return taker.side === 'buy'
      ? makerPrice <= taker.price!
      : makerPrice >= taker.price!;
  }

  /** 一笔成交后检查休眠止损单，触发的按最初提交先后入队 */
  private collectTriggers(tradeSeq: number, price: number): void {
    const fired: InternalOrder[] = [];
    for (const [side, stops] of [
      ['buy', this.sleepingBuyStops],
      ['sell', this.sleepingSellStops],
    ] as const) {
      for (const [id, order] of stops) {
        const hit =
          side === 'buy'
            ? price >= order.stopPrice!
            : price <= order.stopPrice!;
        if (hit) {
          stops.delete(id);
          fired.push(order);
        }
      }
    }
    fired.sort((a, b) => a.submitSeq - b.submitSeq);
    for (const order of fired) {
      this.triggers.push({ orderId: order.id, byTradeSeq: tradeSeq, price });
      this.triggerQueue.push(order);
    }
  }

  /** 依次处理已触发的止损单；处理期间新触发的排在队尾 */
  private drainTriggerQueue(): void {
    while (this.triggerQueue.length > 0) {
      const order = this.triggerQueue.shift()!;
      this.processOrder(order);
    }
  }

  private view(order: InternalOrder): OrderView {
    return {
      id: order.id,
      side: order.side,
      type: order.type,
      price: order.price,
      stopPrice: order.stopPrice,
      quantity: order.quantity,
      filledQuantity: order.filled,
      remainingQuantity: order.quantity - order.filled,
      status: order.status,
    };
  }
}
