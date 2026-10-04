/** 买卖方向 */
export type Side = "buy" | "sell";
/** 订单类型 */
export type OrderType = "limit" | "market" | "stop_limit";
/** 订单生命周期状态 */
export type OrderStatus = "open" | "sleeping" | "filled" | "canceled";
/** 提交订单请求，价格与数量均为整数最小单位 */
export interface SubmitOrderRequest {
    readonly type: OrderType;
    readonly side: Side;
    /** 限价单/止损限价单必填；市价单忽略 */
    readonly price?: number;
    /** 止损限价单必填：触发价 */
    readonly stopPrice?: number;
    readonly quantity: number;
}
/** 一笔成交 */
export interface Trade {
    readonly tradeId: number;
    readonly price: number;
    readonly quantity: number;
    readonly makerOrderId: number;
    readonly takerOrderId: number;
}
/** 一条止损单触发记录 */
export interface TriggerEvent {
    readonly orderId: number;
    readonly stopPrice: number;
    /** 触发时的最新成交价 */
    readonly lastTradePrice: number;
}
/** 提交订单的返回：本次提交直接产生的成交与触发记录 */
export interface SubmitResult {
    readonly orderId: number;
    readonly trades: Trade[];
    readonly triggers: TriggerEvent[];
}
/** 盘口一档 */
export interface BookLevel {
    readonly price: number;
    readonly totalQuantity: number;
    readonly orderCount: number;
}
/** 订单状态视图 */
export interface OrderView {
    readonly orderId: number;
    readonly type: OrderType;
    readonly side: Side;
    readonly price: number | null;
    readonly stopPrice: number | null;
    readonly quantity: number;
    readonly filledQuantity: number;
    readonly remainingQuantity: number;
    readonly status: OrderStatus;
}
