import test from "node:test";
import assert from "node:assert/strict";
import {
  Clock,
  PICKUP_WINDOW_MS,
  ReservationError,
  ReservationService,
} from "../src/index.js";

class FakeClock implements Clock {
  constructor(private current: number) {}
  now(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
}

const T0 = 1_700_000_000_000; // 固定 UTC 起点
const HOUR = 60 * 60 * 1000;

function setup(now: number = T0) {
  const clock = new FakeClock(now);
  const service = new ReservationService(":memory:", { clock });
  return { clock, service };
}

test("创建班次与预约：占用名额、重复订单与超额校验", () => {
  const { service } = setup();
  service.createShift("s1", 10, T0);
  service.createReservation("o1", "s1", 4);
  service.createReservation("o2", "s1", 6);

  const status = service.getShiftStatus("s1");
  assert.equal(status.occupied, 10);
  assert.equal(status.available, 0);

  assert.throws(
    () => service.createReservation("o1", "s1", 1),
    (e) => e instanceof ReservationError && e.code === "DUPLICATE_ORDER",
  );
  assert.throws(
    () => service.createReservation("o3", "s1", 1),
    (e) => e instanceof ReservationError && e.code === "CAPACITY_EXCEEDED",
  );
  assert.throws(
    () => service.createReservation("o4", "s1", 0),
    (e) => e instanceof ReservationError && e.code === "INVALID_SLOTS",
  );
  service.close();
});

test("两个满班次整批换位成功", () => {
  const { service } = setup();
  service.createShift("s1", 10, T0);
  service.createShift("s2", 10, T0 + HOUR);
  service.createReservation("o1", "s1", 10);
  service.createReservation("o2", "s2", 10);

  service.applyBatch([
    { kind: "rebook", orderId: "o1", targetShiftId: "s2" },
    { kind: "rebook", orderId: "o2", targetShiftId: "s1" },
  ]);

  assert.equal(service.getReservation("o1").shiftId, "s2");
  assert.equal(service.getReservation("o2").shiftId, "s1");
  assert.equal(service.getShiftStatus("s1").occupied, 10);
  assert.equal(service.getShiftStatus("s2").occupied, 10);
  service.close();
});

test("改约后越过旧班次截止时间仍有效，截止时间随新班次", () => {
  const { clock, service } = setup();
  service.createShift("early", 5, T0);
  service.createShift("late", 5, T0 + 48 * HOUR);
  service.createReservation("o1", "early", 3);

  service.applyBatch([{ kind: "rebook", orderId: "o1", targetShiftId: "late" }]);

  // 越过旧班次的截止时间：预约仍有效，名额仍占用在新班次
  clock.advance(PICKUP_WINDOW_MS + HOUR);
  const view = service.getReservation("o1");
  assert.equal(view.state, "active");
  assert.equal(view.shiftId, "late");
  assert.equal(view.deadlineUtc, T0 + 48 * HOUR + PICKUP_WINDOW_MS);
  assert.equal(service.getShiftStatus("late").occupied, 3);
  assert.equal(service.getShiftStatus("early").occupied, 0);

  // 旧截止时间到来不能释放新班次名额；新截止时间前仍可取件
  clock.advance(24 * HOUR);
  service.confirmPickup("o1");
  assert.equal(service.getReservation("o1").state, "confirmed");
  service.close();
});

test("到期预约未清理也立即让出容量，已取件预约始终占用", () => {
  const { clock, service } = setup();
  service.createShift("s1", 10, T0);
  service.createReservation("o1", "s1", 6);
  service.createReservation("o2", "s1", 4);

  // o1 取件确认
  service.confirmPickup("o1");

  // 越过截止时间，o2 到期（未执行清理）
  clock.advance(PICKUP_WINDOW_MS);

  const view = service.getReservation("o2");
  assert.equal(view.state, "expired");
  // 业务口径：到期即让出，与清理是否执行无关
  const status = service.getShiftStatus("s1");
  assert.equal(status.occupied, 6); // 只剩已确认的 o1
  assert.equal(status.confirmedSlots, 6);
  assert.equal(status.activeSlots, 0);

  // 到期班次不再接受新预约
  assert.throws(
    () => service.createReservation("o3", "s1", 4),
    (e) => e instanceof ReservationError && e.code === "SHIFT_PAST_DEADLINE",
  );

  // 已确认取件的预约永久占用，不再超时
  clock.advance(365 * 24 * HOUR);
  assert.equal(service.getShiftStatus("s1").confirmedSlots, 6);
  assert.equal(service.getReservation("o1").state, "confirmed");
  service.close();
});

test("到期清理只标记，不改变业务口径；恰好到达截止时间即超时", () => {
  const { clock, service } = setup();
  service.createShift("s1", 4, T0);
  service.createReservation("o1", "s1", 4);

  // 截止时间前一毫秒仍可取件
  clock.advance(PICKUP_WINDOW_MS - 1);
  assert.equal(service.getReservation("o1").state, "active");

  // 恰好到达截止时间即超时
  clock.advance(1);
  assert.equal(service.getReservation("o1").state, "expired");
  assert.throws(
    () => service.confirmPickup("o1"),
    (e) => e instanceof ReservationError && e.code === "RESERVATION_NOT_CHANGEABLE",
  );

  const marked = service.sweepExpired();
  assert.equal(marked, 1);
  assert.equal(service.sweepExpired(), 0); // 幂等
  assert.equal(service.getShiftStatus("s1").occupied, 0);
  service.close();
});

test("批量变更原子性：任一预约不可变更则整批不生效", () => {
  const { clock, service } = setup();
  service.createShift("s1", 10, T0);
  service.createShift("s2", 10, T0 + HOUR);
  service.createReservation("o1", "s1", 5);
  service.createReservation("o2", "s1", 5);
  service.confirmPickup("o1");

  // o1 已取件，整批失败，o2 保持原班次
  assert.throws(
    () =>
      service.applyBatch([
        { kind: "rebook", orderId: "o2", targetShiftId: "s2" },
        { kind: "cancel", orderId: "o1" },
      ]),
    (e) => e instanceof ReservationError && e.code === "RESERVATION_NOT_CHANGEABLE",
  );
  assert.equal(service.getReservation("o2").shiftId, "s1");
  assert.equal(service.getReservation("o2").state, "active");
  assert.equal(service.getShiftStatus("s2").occupied, 0);

  // o2 超时后，整批同样失败
  clock.advance(PICKUP_WINDOW_MS);
  assert.throws(
    () => service.applyBatch([{ kind: "cancel", orderId: "o2" }]),
    (e) => e instanceof ReservationError && e.code === "RESERVATION_NOT_CHANGEABLE",
  );
  service.close();
});

test("目标班次已到截止时间则整批不生效", () => {
  const { clock, service } = setup();
  service.createShift("s1", 10, T0);
  service.createShift("s2", 10, T0 + HOUR);
  service.createReservation("o1", "s1", 5);

  clock.advance(HOUR + PICKUP_WINDOW_MS); // s2 已到截止时间，s1 也已过期
  // s1 上的 o1 也已超时 -> 不可变更
  assert.throws(
    () => service.applyBatch([{ kind: "rebook", orderId: "o1", targetShiftId: "s2" }]),
    (e) => e instanceof ReservationError && e.code === "RESERVATION_NOT_CHANGEABLE",
  );
  service.close();
});

test("目标班次到达截止时间但源预约仍有效时，整批不生效且源预约保留", () => {
  const { clock, service } = setup();
  service.createShift("s1", 10, T0 + 48 * HOUR);
  service.createShift("s2", 10, T0);
  service.createReservation("o1", "s1", 5);

  clock.advance(PICKUP_WINDOW_MS); // s2 到截止时间，s1 仍有效
  assert.throws(
    () => service.applyBatch([{ kind: "rebook", orderId: "o1", targetShiftId: "s2" }]),
    (e) => e instanceof ReservationError && e.code === "SHIFT_PAST_DEADLINE",
  );
  const view = service.getReservation("o1");
  assert.equal(view.state, "active");
  assert.equal(view.shiftId, "s1");
  assert.equal(service.getShiftStatus("s1").occupied, 5);
  service.close();
});

test("净占用判断：改约腾出名额后同批另一笔改入可以成功", () => {
  const { service } = setup();
  service.createShift("s1", 10, T0);
  service.createShift("s2", 10, T0 + HOUR);
  service.createReservation("o1", "s1", 10);
  service.createReservation("o2", "s2", 4);

  // o1 离开 s1，o2 改入 s1：s1 净占用 4，成功
  service.applyBatch([
    { kind: "rebook", orderId: "o1", targetShiftId: "s2" },
    { kind: "rebook", orderId: "o2", targetShiftId: "s1" },
  ]);
  assert.equal(service.getShiftStatus("s1").occupied, 4);
  assert.equal(service.getShiftStatus("s2").occupied, 10);
  service.close();
});

test("整批后任一班次超额则整批不生效", () => {
  const { service } = setup();
  service.createShift("s1", 10, T0);
  service.createShift("s2", 6, T0 + HOUR);
  service.createReservation("o1", "s1", 8);
  service.createReservation("o2", "s1", 2);

  // o1 改入 s2（容量 6）会超额 -> 整批失败，o2 的取消也不生效
  assert.throws(
    () =>
      service.applyBatch([
        { kind: "rebook", orderId: "o1", targetShiftId: "s2" },
        { kind: "cancel", orderId: "o2" },
      ]),
    (e) => e instanceof ReservationError && e.code === "CAPACITY_EXCEEDED",
  );
  assert.equal(service.getReservation("o1").shiftId, "s1");
  assert.equal(service.getReservation("o2").state, "active");
  assert.equal(service.getShiftStatus("s1").occupied, 10);
  service.close();
});

test("取消释放名额；已取件预约不能取消或改约", () => {
  const { service } = setup();
  service.createShift("s1", 5, T0);
  service.createShift("s2", 5, T0 + HOUR);
  service.createReservation("o1", "s1", 5);
  service.confirmPickup("o1");

  assert.throws(
    () => service.applyBatch([{ kind: "cancel", orderId: "o1" }]),
    (e) => e instanceof ReservationError && e.code === "RESERVATION_NOT_CHANGEABLE",
  );
  assert.throws(
    () => service.applyBatch([{ kind: "rebook", orderId: "o1", targetShiftId: "s2" }]),
    (e) => e instanceof ReservationError && e.code === "RESERVATION_NOT_CHANGEABLE",
  );
  assert.equal(service.getShiftStatus("s1").occupied, 5);

  // 未取件的可以取消并释放名额
  service.createReservation("o2", "s2", 5);
  service.applyBatch([{ kind: "cancel", orderId: "o2" }]);
  assert.equal(service.getReservation("o2").state, "cancelled");
  assert.equal(service.getShiftStatus("s2").occupied, 0);
  // 取消后不可再次变更
  assert.throws(
    () => service.applyBatch([{ kind: "cancel", orderId: "o2" }]),
    (e) => e instanceof ReservationError && e.code === "RESERVATION_NOT_CHANGEABLE",
  );
  service.close();
});

test("取件确认时间窗：开始前不可取件，确认后幂等", () => {
  const { clock, service } = setup(T0 - HOUR);
  service.createShift("s1", 5, T0);
  service.createReservation("o1", "s1", 5);

  assert.throws(
    () => service.confirmPickup("o1"),
    (e) => e instanceof ReservationError && e.code === "RESERVATION_NOT_CHANGEABLE",
  );

  clock.advance(HOUR); // 到达取件起点
  service.confirmPickup("o1");
  service.confirmPickup("o1"); // 幂等
  assert.equal(service.getReservation("o1").state, "confirmed");
  service.close();
});

test("数据持久化：重新打开同一数据库后状态保留", () => {
  const path = `/tmp/reservation-test-${process.pid}.db`;
  const clock = new FakeClock(T0);
  const s1 = new ReservationService(path, { clock });
  s1.createShift("s1", 5, T0);
  s1.createReservation("o1", "s1", 5);
  s1.confirmPickup("o1");
  s1.close();

  const s2 = new ReservationService(path, { clock });
  assert.equal(s2.getReservation("o1").state, "confirmed");
  assert.equal(s2.getShiftStatus("s1").occupied, 5);
  s2.close();
});
