import type { BookLevel, OrderView, SubmitOrderRequest, SubmitResult } from "./types.js";
/** 单交易对撮合引擎，订单簿与成交状态全部保存在进程内存中 */
export declare class MatchingEngine {
    private bids;
    private asks;
    private orders;
    /** 休眠中的止损买单：按触发价降序，队尾为最小触发价 */
    private buyStops;
    /** 休眠中的止损卖单：按触发价升序，队尾为最大触发价 */
    private sellStops;
    private nextOrderId;
    private nextTradeId;
    private nextSeq;
    private lastPrice;
    submit(req: SubmitOrderRequest): SubmitResult;
    cancel(orderId: number): boolean;
    /** 盘口深度：bids 按价格降序，asks 按价格升序 */
    depth(levels?: number): {
        bids: BookLevel[];
        asks: BookLevel[];
    };
    orderStatus(orderId: number): OrderView | null;
    lastTradePrice(): number | null;
    private validate;
    /** 止损单激活后按普通限价单撮合；市价单余量撤销，限价单余量挂单 */
    private match;
    private stopConditionMet;
    private fireTrigger;
    /** 收集某笔成交后新触发的休眠单，按最初提交先后排序 */
    private collectTriggered;
    private sleep;
    private removeSleeping;
}
