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
export declare class OrderBook {
    readonly side: Side;
    /** 有序价档：买单降序，卖单升序 */
    private prices;
    private levelsByPrice;
    private byOrderId;
    constructor(side: Side);
    private better;
    add(entry: BookEntry): void;
    remove(orderId: number): BookEntry | null;
    /** 最优价档队首订单 */
    best(): BookEntry | null;
    bestPrice(): number | null;
    levels(): BookLevel[];
    get size(): number;
}
