import { test } from "node:test";
import assert from "node:assert/strict";
import { SlotAllocator } from "../src/index.ts";

test("capacity greater than 1 allows overlapping bookings up to the limit", () => {
  const a = new SlotAllocator();
  a.setCalendar("d1", [{ start: 0, end: 60, capacity: 2 }]);
  const b1 = a.book("d1", 0, 30);
  const b2 = a.book("d1", 0, 30);
  const b3 = a.book("d1", 0, 30);
  assert.ok(b1 !== null && b2 !== null);
  assert.equal(b3, null);
  // A 15-minute booking still fails everywhere inside [0,30) but fits at 30.
  assert.equal(a.findEarliest("d1", 0, 60, 15), 30);
});

test("partial overlap consumes capacity only on shared minutes", () => {
  const a = new SlotAllocator();
  a.setCalendar("d1", [{ start: 0, end: 120, capacity: 1 }]);
  assert.ok(a.book("d1", 10, 30) !== null); // occupies [10,40)
  assert.equal(a.book("d1", 20, 30), null); // [20,50) overlaps [10,40)
  assert.equal(a.findEarliest("d1", 0, 120, 30), 40); // first gap of 30 after [10,40)
  assert.equal(a.findEarliest("d1", 0, 120, 15), 40); // [0,10) is only 10 free minutes
  assert.equal(a.findEarliest("d1", 0, 120, 60), 40); // [40,120) is 80 free minutes
});

test("endpoint-touching bookings do not overlap", () => {
  const a = new SlotAllocator();
  a.setCalendar("d1", [{ start: 0, end: 90, capacity: 1 }]);
  assert.ok(a.book("d1", 0, 30) !== null);
  assert.ok(a.book("d1", 30, 30) !== null); // starts exactly when previous ends
  assert.equal(a.findEarliest("d1", 0, 90, 30), 60);
  assert.equal(a.findEarliest("d1", 0, 90, 60), null); // [60,90) is only 30 minutes
});

test("booking may span adjacent segments with different capacities", () => {
  const a = new SlotAllocator();
  a.setCalendar("d1", [
    { start: 0, end: 30, capacity: 2 },
    { start: 30, end: 60, capacity: 1 },
  ]);
  // Two bookings crossing the boundary: both need capacity on both sides.
  assert.ok(a.book("d1", 15, 30) !== null); // [15,45)
  assert.equal(a.book("d1", 15, 30), null); // second one fails on [30,45) where capacity is 1
  assert.ok(a.book("d1", 0, 15) !== null); // fits in the capacity-2 region
  assert.ok(a.book("d1", 0, 15) !== null); // capacity 2 allows a second one
  assert.equal(a.book("d1", 0, 15), null); // capacity 2 exhausted on [0,15)
  assert.equal(a.findEarliest("d1", 0, 60, 15), 15); // [15,30) still has 1 left
});

test("bookings cannot span an unopened gap", () => {
  const a = new SlotAllocator();
  a.setCalendar("d1", [
    { start: 0, end: 30, capacity: 1 },
    { start: 45, end: 75, capacity: 1 },
  ]);
  assert.equal(a.book("d1", 15, 30), null); // [15,45) hits the gap at 30
  assert.equal(a.findEarliest("d1", 0, 75, 30), 0); // [0,30) fits entirely before the gap
  assert.equal(a.findEarliest("d1", 0, 75, 60), null); // 60 minutes never fit on either side
  assert.ok(a.book("d1", 0, 30) !== null);
  assert.equal(a.findEarliest("d1", 0, 75, 30), 45);
});

test("query does not consume capacity", () => {
  const a = new SlotAllocator();
  a.setCalendar("d1", [{ start: 0, end: 60, capacity: 1 }]);
  assert.equal(a.findEarliest("d1", 0, 60, 30), 0);
  assert.equal(a.findEarliest("d1", 0, 60, 30), 0);
  assert.ok(a.book("d1", 0, 30) !== null);
});

test("cancel releases exactly the booked range; double cancel is a no-op", () => {
  const a = new SlotAllocator();
  a.setCalendar("d1", [{ start: 0, end: 60, capacity: 1 }]);
  const b1 = a.book("d1", 0, 30)!;
  const b2 = a.book("d1", 30, 30)!;
  assert.ok(b1 !== null && b2 !== null);
  assert.equal(a.findEarliest("d1", 0, 60, 30), null);
  assert.equal(a.cancel(b1), true);
  assert.equal(a.findEarliest("d1", 0, 60, 30), 0);
  assert.equal(a.cancel(b1), false); // repeated cancel must not add capacity
  assert.equal(a.findEarliest("d1", 0, 60, 30), 0);
  assert.ok(a.book("d1", 0, 30) !== null); // capacity 1: only one slot fits now
  assert.equal(a.findEarliest("d1", 0, 60, 30), null);
  assert.equal(a.cancel(b2), true);
  assert.equal(a.findEarliest("d1", 0, 60, 30), 30);
  assert.equal(a.findEarliest("d1", 0, 60, 60), null); // [0,30) is still occupied
});

test("earliest start may be any integer minute, not aligned to duration", () => {
  const a = new SlotAllocator();
  a.setCalendar("d1", [{ start: 0, end: 100, capacity: 1 }]);
  assert.ok(a.book("d1", 3, 15) !== null); // non-aligned start minute is allowed
  assert.equal(a.findEarliest("d1", 0, 100, 15), 18);
  assert.equal(a.findEarliest("d1", 7, 100, 15), 18); // [7,22) would overlap [3,18)
  assert.equal(a.findEarliest("d1", 0, 100, 30), 18);
  assert.ok(a.book("d1", 18, 15) !== null); // endpoint-adjacent to [3,18)
  assert.equal(a.findEarliest("d1", 0, 100, 15), 33);
});

test("query window boundaries are respected", () => {
  const a = new SlotAllocator();
  a.setCalendar("d1", [{ start: 100, end: 200, capacity: 1 }]);
  assert.equal(a.findEarliest("d1", 0, 50, 15), null); // window before calendar
  assert.equal(a.findEarliest("d1", 0, 115, 15), 100); // clipped to calendar
  assert.equal(a.findEarliest("d1", 120, 130, 15), null); // window shorter than duration
  assert.equal(a.findEarliest("d1", 105, 200, 15), 105); // start not aligned
  assert.equal(a.findEarliest("d1", 190, 300, 15), null); // 190+15 exceeds the calendar end
  assert.equal(a.findEarliest("d1", 180, 300, 15), 180); // window extends past calendar; slot must fit inside
  assert.equal(a.findEarliest("d1", 0, 200, 60), 100);
  assert.equal(a.findEarliest("d1", 141, 200, 60), null); // 141+60 > 200
});

test("doctors are independent", () => {
  const a = new SlotAllocator();
  a.setCalendar("d1", [{ start: 0, end: 60, capacity: 1 }]);
  a.setCalendar("d2", [{ start: 0, end: 60, capacity: 1 }]);
  assert.ok(a.book("d1", 0, 60) !== null);
  assert.equal(a.findEarliest("d1", 0, 60, 15), null);
  assert.equal(a.findEarliest("d2", 0, 60, 15), 0);
});

test("invalid inputs are rejected", () => {
  const a = new SlotAllocator();
  assert.throws(() => a.setCalendar("d1", [{ start: 0, end: 60, capacity: 0 }]));
  assert.throws(() => a.setCalendar("d1", [{ start: 0, end: 60, capacity: 9 }]));
  assert.throws(() => a.setCalendar("d1", [{ start: 10, end: 5, capacity: 1 }]));
  assert.throws(() =>
    a.setCalendar("d1", [
      { start: 0, end: 30, capacity: 1 },
      { start: 20, end: 40, capacity: 1 },
    ]),
  );
  a.setCalendar("d1", [{ start: 0, end: 60, capacity: 1 }]);
  assert.throws(() => a.setCalendar("d1", [{ start: 0, end: 60, capacity: 1 }]));
  assert.throws(() => a.book("d1", 0, 20 as never));
  assert.throws(() => a.book("d1", 0.5, 15));
  assert.throws(() => a.findEarliest("nope", 0, 60, 15));
  assert.equal(a.cancel("missing"), false);
});
