/** 订单方向 */
export type Side = 'buy' | 'sell';

/** 订单类型：限价 / 市价 / 止损限价 */
export type OrderType = 'limit' | 'market' | 'stop_limit';

/** 订单状态 */
export type OrderStatus =
  | 'open' // 在普通盘口中挂单
  | 'sleeping' // 止损单休眠，未进入盘口
  | 'filled' // 全部成交
  | 'canceled'; // 余量已撤销（含市价单未成交余量）

/** 提交订单请求。价格与数量均为整数最小单位。 */
export interface OrderRequest {
  /** 调用方提供的订单 ID，需唯一 */
  id: string;
  side: Side;
  type: OrderType;
  /** 限价单/止损限价单的限价；市价单忽略 */
  price?: number;
  /** 止损限价单的触发价 */
  stopPrice?: number;
  quantity: number;
}

/** 一笔成交记录 */
export interface Trade {
  /** 成交序号，从 1 递增 */
  seq: number;
  /** 主动方（taker）订单 ID */
  takerOrderId: string;
  /** 被动方（maker）订单 ID */
  makerOrderId: string;
  /** 成交价，始终为被动挂单价 */
  price: number;
  quantity: number;
}

/** 一条止损触发记录 */
export interface TriggerEvent {
  /** 被触发的订单 ID */
  orderId: string;
  /** 触发它的成交序号；提交时立即激活则为 null */
  byTradeSeq: number | null;
  /** 触发时的最新成交价 */
  price: number;
}

/** 提交订单的返回结果 */
export interface SubmitResult {
  trades: Trade[];
  triggers: TriggerEvent[];
  order: OrderView;
}

/** 订单对外视图 */
export interface OrderView {
  id: string;
  side: Side;
  type: OrderType;
  price: number | null;
  stopPrice: number | null;
  quantity: number;
  filledQuantity: number;
  remainingQuantity: number;
  status: OrderStatus;
}

/** 盘口某一价位档 */
export interface BookLevel {
  price: number;
  totalQuantity: number;
  orderCount: number;
}

/** 盘口快照 */
export interface BookSnapshot {
  /** 卖档，价格升序 */
  asks: BookLevel[];
  /** 买档，价格降序 */
  bids: BookLevel[];
}
