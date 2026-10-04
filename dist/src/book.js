/** 单边普通盘口：价格优先、同价按进入盘口先后（FIFO） */
export class OrderBook {
    side;
    /** 有序价档：买单降序，卖单升序 */
    prices = [];
    levelsByPrice = new Map();
    byOrderId = new Map();
    constructor(side) {
        this.side = side;
    }
    better(a, b) {
        return this.side === "buy" ? a > b : a < b;
    }
    add(entry) {
        let level = this.levelsByPrice.get(entry.price);
        if (level === undefined) {
            level = [];
            this.levelsByPrice.set(entry.price, level);
            // 二分插入保持 prices 有序
            let lo = 0;
            let hi = this.prices.length;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (this.prices[mid] === entry.price)
                    break;
                if (this.better(entry.price, this.prices[mid]))
                    hi = mid;
                else
                    lo = mid + 1;
            }
            this.prices.splice(lo, 0, entry.price);
        }
        level.push(entry);
        this.byOrderId.set(entry.orderId, entry);
    }
    remove(orderId) {
        const entry = this.byOrderId.get(orderId);
        if (entry === undefined)
            return null;
        this.byOrderId.delete(orderId);
        const level = this.levelsByPrice.get(entry.price);
        const idx = level.indexOf(entry);
        if (idx >= 0)
            level.splice(idx, 1);
        if (level.length === 0) {
            this.levelsByPrice.delete(entry.price);
            const pi = this.prices.indexOf(entry.price);
            if (pi >= 0)
                this.prices.splice(pi, 1);
        }
        return entry;
    }
    /** 最优价档队首订单 */
    best() {
        const price = this.bestPrice();
        if (price === null)
            return null;
        return this.levelsByPrice.get(price)[0] ?? null;
    }
    bestPrice() {
        return this.prices.length === 0 ? null : this.prices[0];
    }
    levels() {
        return this.prices.map((price) => {
            const level = this.levelsByPrice.get(price);
            let total = 0;
            for (const e of level)
                total += e.remaining;
            return { price, totalQuantity: total, orderCount: level.length };
        });
    }
    get size() {
        return this.byOrderId.size;
    }
}
//# sourceMappingURL=book.js.map