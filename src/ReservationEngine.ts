import {
  Event,
  InitialInventory,
  InventoryView,
  OrderId,
  OrderLine,
  OrderStatus,
  OrderView,
  Query,
  QueryResult,
  Sku,
  WarehouseId,
} from './types';

export const RESERVATION_TTL_MS = 172_800_000;

interface StockBucket {
  available: number;
  reserved: number;
}

interface OrderRecord {
  orderId: OrderId;
  warehouseId: WarehouseId;
  lines: OrderLine[];
  status: OrderStatus;
  reservedUntil: number | null;
  submitSeq: number;
}

export class ReservationEngine {
  private readonly stock = new Map<WarehouseId, Map<Sku, StockBucket>>();
  private readonly orders = new Map<OrderId, OrderRecord>();
  private now = 0;
  private nextSeq = 0;

  constructor(initialInventory: InitialInventory) {
    for (const [warehouseId, skus] of Object.entries(initialInventory)) {
      const skuMap = new Map<Sku, StockBucket>();
      for (const [sku, quantity] of Object.entries(skus)) {
        if (!Number.isInteger(quantity) || quantity < 0) {
          throw new Error(`初始库存必须是非负整数: ${warehouseId}/${sku}=${quantity}`);
        }
        skuMap.set(sku, { available: quantity, reserved: 0 });
      }
      this.stock.set(warehouseId, skuMap);
    }
  }

  apply(event: Event): void {
    if (!Number.isInteger(event.now) || event.now < this.now) {
      throw new Error(`事件时间必须是非递减的整数毫秒: now=${event.now}, 当前=${this.now}`);
    }
    this.now = event.now;

    this.expireReservations();

    switch (event.type) {
      case 'Submit':
        this.handleSubmit(event.order);
        break;
      case 'Restock':
        this.handleRestock(event.warehouseId, event.sku, event.quantity);
        break;
      case 'Cancel':
        this.handleCancel(event.orderId);
        break;
      case 'Tick':
        break;
    }

    this.backfill();
  }

  inspect(query: Query): QueryResult {
    switch (query.type) {
      case 'Order': {
        const order = this.orders.get(query.orderId);
        return order ? this.toOrderView(order) : null;
      }
      case 'Orders': {
        const views: OrderView[] = [];
        for (const order of this.sortedOrders()) {
          if (query.warehouseId !== undefined && order.warehouseId !== query.warehouseId) {
            continue;
          }
          views.push(this.toOrderView(order));
        }
        return views;
      }
      case 'Inventory': {
        const views: InventoryView[] = [];
        for (const warehouseId of [...this.stock.keys()].sort()) {
          if (query.warehouseId !== undefined && warehouseId !== query.warehouseId) {
            continue;
          }
          const skuMap = this.stock.get(warehouseId)!;
          for (const sku of [...skuMap.keys()].sort()) {
            const bucket = skuMap.get(sku)!;
            views.push({
              warehouseId,
              sku,
              available: bucket.available,
              reserved: bucket.reserved,
            });
          }
        }
        return views;
      }
    }
  }

  private expireReservations(): void {
    const releases: Array<{ order: OrderRecord }> = [];
    for (const order of this.orders.values()) {
      if (order.status === 'reserved' && order.reservedUntil !== null && order.reservedUntil <= this.now) {
        releases.push({ order });
      }
    }
    for (const { order } of releases) {
      order.status = 'expired';
      order.reservedUntil = null;
      this.release(order);
    }
  }

  private handleSubmit(input: { orderId: OrderId; warehouseId: WarehouseId; lines: OrderLine[] }): void {
    if (this.orders.has(input.orderId)) {
      throw new Error(`订单ID重复: ${input.orderId}`);
    }
    const skuMap = this.stock.get(input.warehouseId);
    if (!skuMap) {
      throw new Error(`未知仓库: ${input.warehouseId}`);
    }
    if (input.lines.length === 0) {
      throw new Error(`订单必须至少包含一行需求: ${input.orderId}`);
    }
    const merged = new Map<Sku, number>();
    for (const line of input.lines) {
      if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
        throw new Error(`需求数量必须是正整数: ${input.orderId}/${line.sku}=${line.quantity}`);
      }
      merged.set(line.sku, (merged.get(line.sku) ?? 0) + line.quantity);
    }
    const lines: OrderLine[] = [...merged.entries()].map(([sku, quantity]) => ({ sku, quantity }));
    this.orders.set(input.orderId, {
      orderId: input.orderId,
      warehouseId: input.warehouseId,
      lines,
      status: 'waiting',
      reservedUntil: null,
      submitSeq: this.nextSeq++,
    });
  }

  private handleRestock(warehouseId: WarehouseId, sku: Sku, quantity: number): void {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new Error(`补货数量必须是正整数: ${warehouseId}/${sku}=${quantity}`);
    }
    const bucket = this.bucket(warehouseId, sku);
    bucket.available += quantity;
  }

  private handleCancel(orderId: OrderId): void {
    const order = this.orders.get(orderId);
    if (!order) {
      throw new Error(`未知订单: ${orderId}`);
    }
    if (order.status === 'waiting') {
      order.status = 'cancelled';
    } else if (order.status === 'reserved') {
      order.status = 'cancelled';
      order.reservedUntil = null;
      this.release(order);
    }
  }

  private backfill(): void {
    for (;;) {
      let candidate: OrderRecord | null = null;
      for (const order of this.orders.values()) {
        if (order.status !== 'waiting') {
          continue;
        }
        if (!this.canSatisfy(order)) {
          continue;
        }
        if (candidate === null || order.submitSeq < candidate.submitSeq) {
          candidate = order;
        }
      }
      if (candidate === null) {
        return;
      }
      candidate.status = 'reserved';
      candidate.reservedUntil = this.now + RESERVATION_TTL_MS;
      const skuMap = this.stock.get(candidate.warehouseId)!;
      for (const line of candidate.lines) {
        const bucket = skuMap.get(line.sku)!;
        bucket.available -= line.quantity;
        bucket.reserved += line.quantity;
      }
    }
  }

  private canSatisfy(order: OrderRecord): boolean {
    const skuMap = this.stock.get(order.warehouseId)!;
    for (const line of order.lines) {
      const bucket = skuMap.get(line.sku);
      if (!bucket || bucket.available < line.quantity) {
        return false;
      }
    }
    return true;
  }

  private release(order: OrderRecord): void {
    const skuMap = this.stock.get(order.warehouseId)!;
    for (const line of order.lines) {
      const bucket = skuMap.get(line.sku)!;
      bucket.available += line.quantity;
      bucket.reserved -= line.quantity;
    }
  }

  private bucket(warehouseId: WarehouseId, sku: Sku): StockBucket {
    let skuMap = this.stock.get(warehouseId);
    if (!skuMap) {
      skuMap = new Map<Sku, StockBucket>();
      this.stock.set(warehouseId, skuMap);
    }
    let bucket = skuMap.get(sku);
    if (!bucket) {
      bucket = { available: 0, reserved: 0 };
      skuMap.set(sku, bucket);
    }
    return bucket;
  }

  private sortedOrders(): OrderRecord[] {
    return [...this.orders.values()].sort((a, b) => a.submitSeq - b.submitSeq);
  }

  private toOrderView(order: OrderRecord): OrderView {
    return {
      orderId: order.orderId,
      warehouseId: order.warehouseId,
      status: order.status,
      lines: order.lines.map((line) => ({ ...line })),
      reservedUntil: order.reservedUntil,
    };
  }
}
