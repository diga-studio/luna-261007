/** 订单状态 */
export type OrderStatus = 'waiting' | 'reserved' | 'cancelled' | 'expired';

/** 仓库 -> SKU -> 数量 */
export type InventoryMap = Record<string, Record<string, number>>;

/** 订单需求:SKU -> 数量 */
export type DemandMap = Record<string, number>;

export interface SubmitEvent {
  type: 'submit';
  now: number;
  orderId: string;
  warehouse: string;
  demand: DemandMap;
}

export interface RestockEvent {
  type: 'restock';
  now: number;
  warehouse: string;
  sku: string;
  quantity: number;
}

export interface CancelEvent {
  type: 'cancel';
  now: number;
  orderId: string;
}

export interface TickEvent {
  type: 'tick';
  now: number;
}

export type EngineEvent = SubmitEvent | RestockEvent | CancelEvent | TickEvent;

export interface OrderView {
  orderId: string;
  warehouse: string;
  demand: DemandMap;
  status: OrderStatus;
  /** 预留成功时的截止时间(now + 48h);未预留为 null */
  deadline: number | null;
}

export interface InventoryView {
  warehouse: string;
  sku: string;
  available: number;
  reserved: number;
}

export interface EngineSnapshot {
  orders: OrderView[];
  inventory: InventoryView[];
}

export interface InspectQuery {
  orderId?: string;
  warehouse?: string;
}

/** 预留保留时长:48 小时(毫秒) */
export const RESERVATION_TTL_MS = 172_800_000;

interface OrderRecord {
  orderId: string;
  warehouse: string;
  demand: DemandMap;
  status: OrderStatus;
  deadline: number | null;
  /** 提交序号,按 Submit 调用顺序从 0 递增 */
  seq: number;
}

interface SkuBucket {
  available: number;
  reserved: number;
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

export class ReservationEngine {
  /** warehouse -> sku -> 库存桶 */
  private readonly inventory = new Map<string, Map<string, SkuBucket>>();
  private readonly orders = new Map<string, OrderRecord>();
  private lastNow: number | null = null;
  private nextSeq = 0;

  constructor(initialInventory: InventoryMap) {
    for (const [warehouse, skus] of Object.entries(initialInventory)) {
      for (const [sku, quantity] of Object.entries(skus)) {
        if (!Number.isInteger(quantity) || quantity < 0) {
          throw new Error(`invalid initial inventory for ${warehouse}/${sku}: ${quantity}`);
        }
        this.bucket(warehouse, sku).available += quantity;
      }
    }
  }

  apply(event: EngineEvent): void {
    if (!Number.isInteger(event.now)) {
      throw new Error(`now must be an integer, got ${event.now}`);
    }
    if (this.lastNow !== null && event.now < this.lastNow) {
      throw new Error(`now must be non-decreasing, got ${event.now} after ${this.lastNow}`);
    }
    this.lastNow = event.now;

    // 第一步:统一处理截止时刻 <= now 的过期,释放全部占用。
    this.expireReservations(event.now);

    // 第二步:处理输入事件。
    switch (event.type) {
      case 'submit':
        this.handleSubmit(event);
        break;
      case 'restock':
        this.handleRestock(event);
        break;
      case 'cancel':
        this.handleCancel(event);
        break;
      case 'tick':
        break;
    }

    // 第三步:回填。按提交序号升序扫描等待单,能满足就整单预留。
    // 预留只消耗库存,不会让此前跳过的旧单变得可满足,因此单趟扫描
    // 等价于"反复选择可满足的最小序号等待单"。
    this.backfill(event.now);
  }

  inspect(query: InspectQuery): EngineSnapshot {
    const orders: OrderView[] = [];
    for (const order of this.orders.values()) {
      if (query.orderId !== undefined && order.orderId !== query.orderId) continue;
      if (query.warehouse !== undefined && order.warehouse !== query.warehouse) continue;
      orders.push({
        orderId: order.orderId,
        warehouse: order.warehouse,
        demand: { ...order.demand },
        status: order.status,
        deadline: order.deadline,
      });
    }
    orders.sort((a, b) => (this.orders.get(a.orderId)?.seq ?? 0) - (this.orders.get(b.orderId)?.seq ?? 0));

    const inventory: InventoryView[] = [];
    for (const [warehouse, skus] of this.inventory) {
      if (query.warehouse !== undefined && warehouse !== query.warehouse) continue;
      for (const [sku, bucket] of skus) {
        inventory.push({
          warehouse,
          sku,
          available: bucket.available,
          reserved: bucket.reserved,
        });
      }
    }
    inventory.sort((a, b) =>
      a.warehouse === b.warehouse ? (a.sku < b.sku ? -1 : 1) : a.warehouse < b.warehouse ? -1 : 1,
    );

    return { orders, inventory };
  }

  private bucket(warehouse: string, sku: string): SkuBucket {
    let skus = this.inventory.get(warehouse);
    if (!skus) {
      skus = new Map();
      this.inventory.set(warehouse, skus);
    }
    let bucket = skus.get(sku);
    if (!bucket) {
      bucket = { available: 0, reserved: 0 };
      skus.set(sku, bucket);
    }
    return bucket;
  }

  private expireReservations(now: number): void {
    for (const order of this.orders.values()) {
      if (order.status === 'reserved' && order.deadline !== null && order.deadline <= now) {
        order.status = 'expired';
        order.deadline = null;
        this.release(order);
      }
    }
  }

  private handleSubmit(event: SubmitEvent): void {
    if (this.orders.has(event.orderId)) {
      throw new Error(`duplicate orderId: ${event.orderId}`);
    }
    const entries = Object.entries(event.demand);
    if (entries.length === 0) {
      throw new Error(`order ${event.orderId} has empty demand`);
    }
    const demand: DemandMap = {};
    for (const [sku, quantity] of entries) {
      if (!isPositiveInteger(quantity)) {
        throw new Error(`order ${event.orderId} invalid demand for ${sku}: ${quantity}`);
      }
      demand[sku] = quantity;
    }
    const order: OrderRecord = {
      orderId: event.orderId,
      warehouse: event.warehouse,
      demand,
      status: 'waiting',
      deadline: null,
      seq: this.nextSeq++,
    };
    this.orders.set(order.orderId, order);
  }

  private handleRestock(event: RestockEvent): void {
    if (!isPositiveInteger(event.quantity)) {
      throw new Error(`restock quantity must be a positive integer, got ${event.quantity}`);
    }
    this.bucket(event.warehouse, event.sku).available += event.quantity;
  }

  private handleCancel(event: CancelEvent): void {
    const order = this.orders.get(event.orderId);
    if (!order) return;
    if (order.status === 'waiting') {
      order.status = 'cancelled';
    } else if (order.status === 'reserved') {
      order.status = 'cancelled';
      order.deadline = null;
      this.release(order);
    }
    // 终态(cancelled/expired)无效果
  }

  private release(order: OrderRecord): void {
    for (const [sku, quantity] of Object.entries(order.demand)) {
      const bucket = this.bucket(order.warehouse, sku);
      bucket.reserved -= quantity;
      bucket.available += quantity;
    }
  }

  private canSatisfy(order: OrderRecord): boolean {
    for (const [sku, quantity] of Object.entries(order.demand)) {
      if (this.bucket(order.warehouse, sku).available < quantity) return false;
    }
    return true;
  }

  private backfill(now: number): void {
    const waiting: OrderRecord[] = [];
    for (const order of this.orders.values()) {
      if (order.status === 'waiting') waiting.push(order);
    }
    waiting.sort((a, b) => a.seq - b.seq);
    for (const order of waiting) {
      if (!this.canSatisfy(order)) continue;
      for (const [sku, quantity] of Object.entries(order.demand)) {
        const bucket = this.bucket(order.warehouse, sku);
        bucket.available -= quantity;
        bucket.reserved += quantity;
      }
      order.status = 'reserved';
      order.deadline = now + RESERVATION_TTL_MS;
    }
  }
}
