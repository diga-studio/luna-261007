'use strict';

const TTL = 172800000;

// 独立参考实现：用普通对象与数组直接表达规格，与被测实现结构不同。
// 状态：stock[wh][sku] = { av, rs }；orders 为按提交顺序排列的数组。
class RefEngine {
  constructor(initialInventory) {
    this.stock = {};
    for (const [wh, skus] of Object.entries(initialInventory)) {
      this.stock[wh] = {};
      for (const [sku, qty] of Object.entries(skus)) {
        this.stock[wh][sku] = { av: qty, rs: 0 };
      }
    }
    this.orders = [];
    this.now = 0;
  }

  apply(event) {
    this.now = event.now;
    // 1. 先让截止时间 <= now 的预留全部过期并释放
    for (const o of this.orders) {
      if (o.status === 'reserved' && o.until <= this.now) {
        o.status = 'expired';
        o.until = null;
        for (const line of o.lines) {
          const b = this.stock[o.wh][line.sku];
          b.av += line.quantity;
          b.rs -= line.quantity;
        }
      }
    }
    // 2. 处理事件
    if (event.type === 'Submit') {
      const merged = {};
      for (const line of event.order.lines) {
        merged[line.sku] = (merged[line.sku] || 0) + line.quantity;
      }
      this.orders.push({
        id: event.order.orderId,
        wh: event.order.warehouseId,
        lines: Object.entries(merged).map(([sku, quantity]) => ({ sku, quantity })),
        status: 'waiting',
        until: null,
      });
    } else if (event.type === 'Restock') {
      const wh = (this.stock[event.warehouseId] = this.stock[event.warehouseId] || {});
      const b = (wh[event.sku] = wh[event.sku] || { av: 0, rs: 0 });
      b.av += event.quantity;
    } else if (event.type === 'Cancel') {
      const o = this.orders.find((x) => x.id === event.orderId);
      if (o && o.status === 'waiting') {
        o.status = 'cancelled';
      } else if (o && o.status === 'reserved') {
        o.status = 'cancelled';
        o.until = null;
        for (const line of o.lines) {
          const b = this.stock[o.wh][line.sku];
          b.av += line.quantity;
          b.rs -= line.quantity;
        }
      }
    }
    // 3. 回填：反复选择可整单满足的、提交序号最小的等待单
    for (;;) {
      const candidate = this.orders.find(
        (o) =>
          o.status === 'waiting' &&
          o.lines.every((line) => {
            const b = (this.stock[o.wh] || {})[line.sku];
            return b && b.av >= line.quantity;
          })
      );
      if (!candidate) break;
      candidate.status = 'reserved';
      candidate.until = this.now + TTL;
      for (const line of candidate.lines) {
        const b = this.stock[candidate.wh][line.sku];
        b.av -= line.quantity;
        b.rs += line.quantity;
      }
    }
  }

  snapshot() {
    const orders = this.orders.map((o) => ({
      orderId: o.id,
      warehouseId: o.wh,
      status: o.status,
      reservedUntil: o.until,
      lines: o.lines.map((l) => ({ ...l })),
    }));
    const inventory = [];
    for (const wh of Object.keys(this.stock).sort()) {
      for (const sku of Object.keys(this.stock[wh]).sort()) {
        const b = this.stock[wh][sku];
        inventory.push({ warehouseId: wh, sku, available: b.av, reserved: b.rs });
      }
    }
    return { orders, inventory };
  }
}

module.exports = { RefEngine, TTL };
