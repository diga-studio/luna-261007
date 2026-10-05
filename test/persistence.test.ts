import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ManualClock, ReservationService, Store } from "../src/index.js";

const HOUR = 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

describe("SQLite 持久化", () => {
  it("关闭重开后班次与预约状态保留", () => {
    const dir = mkdtempSync(join(tmpdir(), "reservation-"));
    const path = join(dir, "data.sqlite");
    try {
      const clock = new ManualClock(T0);
      let store = new Store(path);
      let service = new ReservationService({ store, clock });
      service.registerShift("A", 5, T0);
      const r = service.createReservation("o1", "A", 3);
      service.confirmPickup(r.id);
      store.close();

      store = new Store(path);
      service = new ReservationService({ store, clock });
      clock.setMs(T0 + 1000 * HOUR);
      assert.equal(service.getReservation(r.id).status, "picked_up");
      assert.equal(service.getShiftStatus("A").occupiedSlots, 3);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
