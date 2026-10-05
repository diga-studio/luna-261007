import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CapacityExceededError,
  DuplicateOrderError,
  ManualClock,
  PickupNotStartedError,
  ReservationNotActiveError,
  ReservationService,
  ShiftExpiredError,
  Store,
} from "../src/index.js";

const HOUR = 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

function makeService(startMs: number = T0) {
  const clock = new ManualClock(startMs);
  const store = new Store(":memory:");
  let seq = 0;
  const service = new ReservationService({ store, clock, idGenerator: () => `r${++seq}` });
  return { clock, store, service };
}

describe("创建预约", () => {
  it("创建成功即占用名额，重复订单被拒绝", () => {
    const { service } = makeService();
    service.registerShift("A", 10, T0);
    const r = service.createReservation("o1", "A", 4);
    assert.equal(r.status, "active");
    assert.equal(service.getShiftStatus("A").occupiedSlots, 4);
    assert.throws(() => service.createReservation("o1", "A", 1), DuplicateOrderError);
  });

  it("名额需求必须是正整数，超额创建被拒绝", () => {
    const { service } = makeService();
    service.registerShift("A", 5, T0);
    assert.throws(() => service.createReservation("o1", "A", 0));
    assert.throws(() => service.createReservation("o1", "A", 6), CapacityExceededError);
    service.createReservation("o1", "A", 5);
    assert.throws(() => service.createReservation("o2", "A", 1), CapacityExceededError);
  });

  it("班次到达截止时间后不能再创建预约", () => {
    const { service, clock } = makeService();
    service.registerShift("A", 5, T0);
    clock.setMs(T0 + 72 * HOUR);
    assert.throws(() => service.createReservation("o1", "A", 1), ShiftExpiredError);
  });
});

describe("取件确认", () => {
  it("取件起点前不能取件，起点可以取件", () => {
    const { service, clock } = makeService();
    service.registerShift("A", 5, T0 + 10 * HOUR);
    const r = service.createReservation("o1", "A", 2);
    assert.throws(() => service.confirmPickup(r.id), PickupNotStartedError);
    clock.setMs(T0 + 10 * HOUR);
    service.confirmPickup(r.id);
    assert.equal(service.getReservation(r.id).status, "picked_up");
  });

  it("恰好到达截止时间即超时，不能取件", () => {
    const { service, clock } = makeService();
    service.registerShift("A", 5, T0);
    const r = service.createReservation("o1", "A", 2);
    clock.setMs(T0 + 72 * HOUR - 1);
    service.confirmPickup(r.id);
    assert.equal(service.getReservation(r.id).status, "picked_up");

    service.registerShift("B", 5, T0);
    const r2 = service.createReservation("o2", "B", 2);
    clock.setMs(T0 + 72 * HOUR);
    assert.throws(() => service.confirmPickup(r2.id), ReservationNotActiveError);
  });

  it("已取件预约不能取消或改约", () => {
    const { service } = makeService();
    service.registerShift("A", 5, T0);
    service.registerShift("B", 5, T0);
    const r = service.createReservation("o1", "A", 2);
    service.confirmPickup(r.id);
    assert.throws(
      () => service.applyBatch([{ kind: "cancel", reservationId: r.id }]),
      ReservationNotActiveError,
    );
    assert.throws(
      () => service.applyBatch([{ kind: "move", reservationId: r.id, targetShiftId: "B" }]),
      ReservationNotActiveError,
    );
    assert.equal(service.getReservation(r.id).status, "picked_up");
  });
});

describe("整批变更", () => {
  it("两个满班次整批换位成功（混合取消）", () => {
    const { service } = makeService();
    service.registerShift("A", 10, T0);
    service.registerShift("B", 10, T0);
    const a1 = service.createReservation("a1", "A", 6);
    const a2 = service.createReservation("a2", "A", 4);
    const b1 = service.createReservation("b1", "B", 10);
    assert.equal(service.getShiftStatus("A").availableSlots, 0);
    assert.equal(service.getShiftStatus("B").availableSlots, 0);

    service.applyBatch([
      { kind: "move", reservationId: a1.id, targetShiftId: "B" },
      { kind: "move", reservationId: b1.id, targetShiftId: "A" },
      { kind: "cancel", reservationId: a2.id },
    ]);

    assert.equal(service.getReservation(a1.id).shiftId, "B");
    assert.equal(service.getReservation(b1.id).shiftId, "A");
    assert.equal(service.getReservation(a2.id).status, "cancelled");
    assert.deepEqual(
      { a: service.getShiftStatus("A").occupiedSlots, b: service.getShiftStatus("B").occupiedSlots },
      { a: 10, b: 6 },
    );
  });

  it("等量交换两个满班次的预约成功", () => {
    const { service } = makeService();
    service.registerShift("A", 10, T0);
    service.registerShift("B", 10, T0);
    const a1 = service.createReservation("a1", "A", 10);
    const b1 = service.createReservation("b1", "B", 10);
    service.applyBatch([
      { kind: "move", reservationId: a1.id, targetShiftId: "B" },
      { kind: "move", reservationId: b1.id, targetShiftId: "A" },
    ]);
    assert.equal(service.getReservation(a1.id).shiftId, "B");
    assert.equal(service.getReservation(b1.id).shiftId, "A");
    assert.equal(service.getShiftStatus("A").occupiedSlots, 10);
    assert.equal(service.getShiftStatus("B").occupiedSlots, 10);
  });

  it("最终任一班次超额则整批不生效", () => {
    const { service } = makeService();
    service.registerShift("A", 10, T0);
    service.registerShift("B", 5, T0);
    const a1 = service.createReservation("a1", "A", 6);
    const a2 = service.createReservation("a2", "A", 4);
    assert.throws(
      () =>
        service.applyBatch([
          { kind: "move", reservationId: a1.id, targetShiftId: "B" },
          { kind: "cancel", reservationId: a2.id },
        ]),
      CapacityExceededError,
    );
    assert.equal(service.getReservation(a1.id).shiftId, "A");
    assert.equal(service.getReservation(a2.id).status, "active");
    assert.equal(service.getShiftStatus("A").occupiedSlots, 10);
  });

  it("任一笔已取消/已超时，整批不生效且不影响其他预约", () => {
    const { service, clock } = makeService();
    service.registerShift("A", 10, T0);
    service.registerShift("B", 10, T0);
    service.registerShift("C", 10, T0 + 200 * HOUR);
    const a1 = service.createReservation("a1", "A", 3);
    const a2 = service.createReservation("a2", "A", 3);
    const b1 = service.createReservation("b1", "B", 3);
    service.applyBatch([{ kind: "cancel", reservationId: b1.id }]);
    clock.setMs(T0 + 100 * HOUR); // A 已超时，C 未超时
    assert.throws(
      () =>
        service.applyBatch([
          { kind: "move", reservationId: a1.id, targetShiftId: "C" },
          { kind: "cancel", reservationId: a2.id },
        ]),
      ReservationNotActiveError,
    );
    assert.equal(service.getReservation(a1.id).shiftId, "A");
    assert.equal(service.getReservation(a2.id).status, "active");
  });

  it("目标班次已到截止时间，整批不生效", () => {
    const { service, clock } = makeService();
    service.registerShift("A", 10, T0 + 100 * HOUR);
    service.registerShift("B", 10, T0);
    const a1 = service.createReservation("a1", "A", 3);
    const b1 = service.createReservation("b1", "B", 3);
    clock.setMs(T0 + 72 * HOUR); // B 恰好到达截止时间
    assert.throws(
      () =>
        service.applyBatch([
          { kind: "move", reservationId: a1.id, targetShiftId: "B" },
          { kind: "cancel", reservationId: b1.id },
        ]),
      ShiftExpiredError,
    );
    assert.equal(service.getReservation(a1.id).shiftId, "A");
    assert.equal(service.getReservation(b1.id).status, "active");
  });
});

describe("到期与清理", () => {
  it("改到更晚班次后越过旧截止时间仍保持有效", () => {
    const { service, clock } = makeService();
    service.registerShift("A", 5, T0);
    service.registerShift("B", 5, T0 + 100 * HOUR);
    const r = service.createReservation("o1", "A", 3);
    clock.setMs(T0 + HOUR);
    service.applyBatch([{ kind: "move", reservationId: r.id, targetShiftId: "B" }]);

    clock.setMs(T0 + 80 * HOUR); // 越过旧班次 A 的截止时间
    assert.equal(service.getReservation(r.id).status, "active");
    assert.equal(service.getShiftStatus("B").occupiedSlots, 3);
    assert.throws(() => service.confirmPickup(r.id), PickupNotStartedError);

    clock.setMs(T0 + 100 * HOUR); // 到达新班次取件起点
    service.confirmPickup(r.id);
    assert.equal(service.getReservation(r.id).status, "picked_up");
  });

  it("旧截止时间到来不能释放新班次上的名额", () => {
    const { service, clock } = makeService();
    service.registerShift("A", 5, T0);
    service.registerShift("B", 3, T0 + 100 * HOUR);
    const r = service.createReservation("o1", "A", 3);
    clock.setMs(T0 + HOUR);
    service.applyBatch([{ kind: "move", reservationId: r.id, targetShiftId: "B" }]);
    clock.setMs(T0 + 72 * HOUR); // 旧班次 A 的截止时间
    service.cleanupExpired();
    assert.equal(service.getReservation(r.id).status, "active");
    assert.equal(service.getShiftStatus("B").occupiedSlots, 3);
    assert.throws(() => service.createReservation("o2", "B", 1), CapacityExceededError);
  });

  it("未清理的真正到期预约立即让出容量", () => {
    const { service, clock } = makeService();
    service.registerShift("A", 5, T0);
    const r1 = service.createReservation("o1", "A", 5);
    clock.setMs(T0 + 72 * HOUR); // 恰好超时
    // 未执行 cleanupExpired，业务口径上容量已让出
    const status = service.getShiftStatus("A");
    assert.equal(status.pendingSlots, 0);
    assert.equal(status.occupiedSlots, 0);
    assert.equal(status.availableSlots, 5);
    // 到期预约不能取件、不能参与变更
    assert.throws(() => service.confirmPickup(r1.id), ReservationNotActiveError);
    assert.throws(
      () => service.applyBatch([{ kind: "cancel", reservationId: r1.id }]),
      ReservationNotActiveError,
    );
    // 清理后状态落库，且可重复执行
    assert.deepEqual(service.cleanupExpired(), [r1.id]);
    assert.equal(service.getReservation(r1.id).status, "expired");
    assert.deepEqual(service.cleanupExpired(), []);
    // 清理不影响其他班次的有效预约
    service.registerShift("B", 5, T0 + 100 * HOUR);
    const r2 = service.createReservation("o2", "B", 5);
    assert.equal(service.getReservation(r2.id).status, "active");
  });

  it("已取件预约始终占用容量，不超时", () => {
    const { service, clock } = makeService();
    service.registerShift("A", 5, T0);
    const r = service.createReservation("o1", "A", 5);
    service.confirmPickup(r.id);
    clock.setMs(T0 + 1000 * HOUR);
    service.cleanupExpired();
    assert.equal(service.getReservation(r.id).status, "picked_up");
    assert.equal(service.getShiftStatus("A").occupiedSlots, 5);
    assert.throws(() => service.createReservation("o2", "A", 1), ShiftExpiredError);
  });

  it("取消释放名额", () => {
    const { service } = makeService();
    service.registerShift("A", 5, T0);
    const r = service.createReservation("o1", "A", 5);
    service.applyBatch([{ kind: "cancel", reservationId: r.id }]);
    assert.equal(service.getShiftStatus("A").occupiedSlots, 0);
    service.createReservation("o2", "A", 5);
  });
});
