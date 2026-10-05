export type WarehouseId = string;
export type Sku = string;
export type OrderId = string;

/** 订单行：某 SKU 的需求数量（正整数） */
export interface OrderLine {
  sku: Sku;
  quantity: number;
}

/** 提交订单时的订单内容 */
export interface OrderInput {
  orderId: OrderId;
  warehouseId: WarehouseId;
  lines: OrderLine[];
}

export type Event =
  | { type: 'Submit'; now: number; order: OrderInput }
  | { type: 'Restock'; now: number; warehouseId: WarehouseId; sku: Sku; quantity: number }
  | { type: 'Cancel'; now: number; orderId: OrderId }
  | { type: 'Tick'; now: number };

export type OrderStatus = 'waiting' | 'reserved' | 'cancelled' | 'expired';

export interface OrderView {
  orderId: OrderId;
  warehouseId: WarehouseId;
  status: OrderStatus;
  lines: OrderLine[];
  /** 预留截止时间（预留成功时刻 + 48h）；未预留时为 null */
  reservedUntil: number | null;
}

export interface InventoryView {
  warehouseId: WarehouseId;
  sku: Sku;
  available: number;
  reserved: number;
}

export type Query =
  | { type: 'Order'; orderId: OrderId }
  | { type: 'Orders'; warehouseId?: WarehouseId }
  | { type: 'Inventory'; warehouseId?: WarehouseId };

export type QueryResult = OrderView | OrderView[] | InventoryView[] | null;

/** 初始库存：仓库 -> SKU -> 数量 */
export type InitialInventory = Record<WarehouseId, Record<Sku, number>>;
