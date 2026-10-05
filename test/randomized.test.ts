import test from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';
import {
  ReservationEngine,
  RESERVATION_TTL_MS,
  EngineEvent,
  EngineSnapshot,
  DemandMap,
  InventoryMap,
} from '../src/reservationEngine';

/** 确定性伪随机数生成器(mulberry32) */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// 独立参考实现:每次从初始库存重放全部事件,逐步推导状态。
// 回填严格按规格字面执行:反复寻找可满足的最小提交序号等待单。
// ---------------------------------------------------------------------------

interface RefOrder {
  orderId: string;
  warehouse: string;
  demand: DemandMap;
  status: 'waiting' | 'reserved' | 'cancelled' | 'expired';
  deadline: number | null;
  seq: number;
}

function replay(initial: InventoryMap, events: EngineEvent[]): EngineSnapshot {
  const available = new Map<string, number>();
  const reserved = new Map<string, number>();
  const key = (w: string, s: string) => `${w} ${s}`;
  for (const [w, skus] of Object.entries(initial)) {
    for (const [s, q] of Object.entries(skus)) {
      available.set(key(w, s), (available.get(key(w, s)) ?? 0) + q);
    }
  }
  const orders: RefOrder[] = [];

  const release = (order: RefOrder) => {
    for (const [s, q] of Object.entries(order.demand)) {
      const k = key(order.warehouse, s);
      reserved.set(k, (reserved.get(k) ?? 0) - q);
      available.set(k, (available.get(k) ?? 0) + q);
    }
  };

  for (const event of events) {
    // 1. 过期
    for (const order of orders) {
      if (order.status === 'reserved' && order.deadline !== null && order.deadline <= event.now) {
        order.status = 'expired';
        order.deadline = null;
        release(order);
      }
    }
    // 2. 事件
    if (event.type === 'submit') {
      orders.push({
        orderId: event.orderId,
        warehouse: event.warehouse,
        demand: { ...event.demand },
        status: 'waiting',
        deadline: null,
        seq: orders.length,
      });
    } else if (event.type === 'restock') {
      const k = key(event.warehouse, event.sku);
      available.set(k, (available.get(k) ?? 0) + event.quantity);
    } else if (event.type === 'cancel') {
      const order = orders.find((o) => o.orderId === event.orderId);
      if (order && order.status === 'waiting') {
        order.status = 'cancelled';
      } else if (order && order.status === 'reserved') {
        order.status = 'cancelled';
        order.deadline = null;
        release(order);
      }
    }
    // 3. 回填:反复选择可满足的最小序号等待单
    for (;;) {
      let pick: RefOrder | null = null;
      for (const order of orders) {
        if (order.status !== 'waiting') continue;
        const okAll = Object.entries(order.demand).every(
          ([s, q]) => (available.get(key(order.warehouse, s)) ?? 0) >= q,
        );
        if (okAll) {
          pick = order;
          break; // orders 按 seq 升序,第一个可满足者即最小序号
        }
      }
      if (!pick) break;
      for (const [s, q] of Object.entries(pick.demand)) {
        const k = key(pick.warehouse, s);
        available.set(k, (available.get(k) ?? 0) - q);
        reserved.set(k, (reserved.get(k) ?? 0) + q);
      }
      pick.status = 'reserved';
      pick.deadline = event.now + RESERVATION_TTL_MS;
    }
  }

  const snapshot: EngineSnapshot = { orders: [], inventory: [] };
  for (const order of orders) {
    snapshot.orders.push({
      orderId: order.orderId,
      warehouse: order.warehouse,
      demand: { ...order.demand },
      status: order.status,
      deadline: order.deadline,
    });
  }
  const keys = new Set<string>([...available.keys(), ...reserved.keys()]);
  for (const k of keys) {
    const sep = k.indexOf(' ');
    const warehouse = k.slice(0, sep);
    const sku = k.slice(sep + 1);
    snapshot.inventory.push({
      warehouse,
      sku,
      available: available.get(k) ?? 0,
      reserved: reserved.get(k) ?? 0,
    });
  }
  snapshot.inventory.sort((a, b) =>
    a.warehouse === b.warehouse ? (a.sku < b.sku ? -1 : 1) : a.warehouse < b.warehouse ? -1 : 1,
  );
  return snapshot;
}

// ---------------------------------------------------------------------------
// 随机事件生成
// ---------------------------------------------------------------------------

function randomEvents(rng: () => number, warehouses: string[], skus: string[], count: number) {
  const events: EngineEvent[] = [];
  const orderIds: string[] = [];
  let now = 0;
  let nextId = 0;
  const pick = <T>(arr: T[]): T => arr[Math.floor(rng() * arr.length)] as T;

  for (let i = 0; i < count; i++) {
    // 时间非递减:小步推进为主,偶尔大跳跨过 48h 触发过期
    const jump = rng() < 0.15 ? Math.floor(rng() * 3) * RESERVATION_TTL_MS : Math.floor(rng() * 5000);
    now += jump;
    const roll = rng();
    if (roll < 0.45) {
      const demand: DemandMap = {};
      const skuCount = 1 + Math.floor(rng() * skus.length);
      const chosen = [...skus].sort(() => rng() - 0.5).slice(0, skuCount);
      for (const s of chosen) demand[s] = 1 + Math.floor(rng() * 4);
      const orderId = `R${nextId++}`;
      orderIds.push(orderId);
      events.push({ type: 'submit', now, orderId, warehouse: pick(warehouses), demand });
    } else if (roll < 0.65) {
      const warehouse = pick(warehouses);
      const sku = pick(skus);
      const quantity = 1 + Math.floor(rng() * 3);
      events.push({ type: 'restock', now, warehouse, sku, quantity });
    } else if (roll < 0.85 && orderIds.length > 0) {
      events.push({ type: 'cancel', now, orderId: pick(orderIds) });
    } else {
      events.push({ type: 'tick', now });
    }
  }
  return events;
}

test('随机小规模事件与独立参考实现逐步一致', () => {
  const warehouses = ['W1', 'W2'];
  const skus = ['A', 'B', 'C'];

  for (let seed = 1; seed <= 150; seed++) {
    const rng = makeRng(seed);
    const initial: InventoryMap = {};
    const baseTotals = new Map<string, number>();
    for (const w of warehouses) {
      initial[w] = {};
      for (const s of skus) {
        const q = Math.floor(rng() * 6);
        (initial[w] as Record<string, number>)[s] = q;
        baseTotals.set(`${w} ${s}`, q);
      }
    }
    const events = randomEvents(rng, warehouses, skus, 120);

    const engine = new ReservationEngine(initial);
    const history: EngineEvent[] = [];
    const totals = new Map<string, number>(); // 截至当前事件的累计补货
    for (const event of events) {
      engine.apply(event);
      history.push(event);
      if (event.type === 'restock') {
        const k = `${event.warehouse} ${event.sku}`;
        totals.set(k, (totals.get(k) ?? 0) + event.quantity);
      }
      const actual = engine.inspect({});
      const expected = replay(initial, history);
      deepEqual(actual, expected, `seed=${seed} 在事件 ${JSON.stringify(event)} 后不一致`);

      // 不变量:可用与占用非负,且二者之和 = 初始 + 累计补货
      for (const row of actual.inventory) {
        ok(row.available >= 0, `available 为负: ${JSON.stringify(row)}`);
        ok(row.reserved >= 0, `reserved 为负: ${JSON.stringify(row)}`);
        const k = `${row.warehouse} ${row.sku}`;
        const total = (baseTotals.get(k) ?? 0) + (totals.get(k) ?? 0);
        equal(row.available + row.reserved, total, `库存守恒被破坏: ${k}`);
      }
      // 不变量:apply 返回后不存在仍可整单满足的等待单
      const avail = new Map<string, number>();
      for (const row of actual.inventory) {
        avail.set(`${row.warehouse} ${row.sku}`, row.available);
      }
      for (const order of actual.orders) {
        if (order.status !== 'waiting') continue;
        const satisfiable = Object.entries(order.demand).every(
          ([s, q]) => (avail.get(`${order.warehouse} ${s}`) ?? 0) >= q,
        );
        ok(!satisfiable, `等待单 ${order.orderId} 仍可整单满足`);
      }
    }
  }
});
