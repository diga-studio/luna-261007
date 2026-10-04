import { test } from "node:test";
import assert from "node:assert/strict";
import { SlotAllocator, type CalendarSegment, type Duration, DURATIONS } from "../src/index";
import { BruteForce } from "./brute";
import { Rng } from "./util";

test("capacity greater than 1 allows overlapping appointments up to capacity", () => {
  const allocator = new SlotAllocator();
  allocator.addDoctor("doc", [{ start: 0, end: 120, capacity: 3 }]);
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const id = allocator.book("doc", 10, 30);
    assert.ok(id !== null, `booking ${i} should succeed`);
    ids.push(id);
  }
  assert.equal(allocator.book("doc", 10, 30), null, "4th overlapping booking must fail");
  // A different time still has room.
  assert.ok(allocator.book("doc", 40, 30) !== null);
  // Cancelling one restores exactly one slot.
  assert.equal(allocator.cancel(ids[0] as string), true);
  assert.ok(allocator.book("doc", 10, 30) !== null);
  assert.equal(allocator.book("doc", 10, 30), null);
});

test("partial overlap consumes shared capacity only on the intersection", () => {
  const allocator = new SlotAllocator();
  allocator.addDoctor("doc", [{ start: 0, end: 200, capacity: 1 }]);
  assert.ok(allocator.book("doc", 30, 60) !== null); // [30, 90)
  assert.equal(allocator.book("doc", 0, 60), null, "overlaps [30,60)");
  assert.equal(allocator.book("doc", 60, 60), null, "overlaps [60,90)");
  assert.ok(allocator.book("doc", 0, 30) !== null, "[0,30) only touches at 30");
  assert.ok(allocator.book("doc", 90, 30) !== null, "[90,120) only touches at 90");
  assert.equal(allocator.findEarliest("doc", 0, 200, 15), 120);
});

test("endpoint-touching segments with different capacities", () => {
  const allocator = new SlotAllocator();
  // [0, 60) cap 1, [60, 180) cap 2, [180, 240) cap 1
  allocator.addDoctor("doc", [
    { start: 0, end: 60, capacity: 1 },
    { start: 60, end: 180, capacity: 2 },
    { start: 180, end: 240, capacity: 1 },
  ]);
  // Fill the middle segment twice at the same minute.
  assert.ok(allocator.book("doc", 90, 30) !== null);
  assert.ok(allocator.book("doc", 90, 30) !== null);
  assert.equal(allocator.book("doc", 90, 30), null);
  // Booking ending exactly at a boundary does not consume the next segment.
  assert.ok(allocator.book("doc", 30, 30) !== null); // [30,60) in cap-1 zone
  assert.equal(allocator.book("doc", 15, 60), null, "would hit [30,60) occupancy");
  // Booking starting exactly at a boundary only consumes the right side.
  assert.ok(allocator.book("doc", 180, 30) !== null);
  assert.equal(allocator.book("doc", 180, 15), null, "cap-1 tail is full at 180");
});

test("booking crossing a capacity-change boundary is limited by the minimum", () => {
  const allocator = new SlotAllocator();
  // [0, 100) cap 2, [100, 200) cap 1
  allocator.addDoctor("doc", [
    { start: 0, end: 100, capacity: 2 },
    { start: 100, end: 200, capacity: 1 },
  ]);
  assert.ok(allocator.book("doc", 70, 60) !== null, "crosses the boundary at 100");
  // One capacity left on [0,100) but none on [100,130).
  assert.equal(allocator.book("doc", 70, 60), null, "second crossing exceeds cap 1 on the right");
  assert.ok(allocator.book("doc", 40, 30) !== null, "fits entirely in the cap-2 zone");
  assert.equal(allocator.book("doc", 85, 30), null, "crosses into the full cap-1 zone");
  // Occupancy now: [40,70) x1, [70,100) x1, [100,130) x1.
  // A 60-min window starting at 0 only meets occupancy 1 against capacity 2.
  assert.equal(allocator.findEarliest("doc", 0, 200, 60), 0);
  // Once the cap-2 zone is filled too, the boundary really blocks.
  assert.ok(allocator.book("doc", 20, 60) !== null); // [20,80), second capacity
  assert.equal(allocator.findEarliest("doc", 0, 200, 60), 130);
});

test("cannot cross an unopened gap", () => {
  const allocator = new SlotAllocator();
  allocator.addDoctor("doc", [
    { start: 0, end: 60, capacity: 8 },
    { start: 120, end: 180, capacity: 8 },
  ]);
  assert.equal(allocator.book("doc", 30, 60), null, "spans the gap [60,120)");
  assert.equal(allocator.findEarliest("doc", 0, 180, 60), 0);
  assert.equal(allocator.findEarliest("doc", 61, 180, 60), 120);
  assert.equal(allocator.findEarliest("doc", 0, 60, 60), 0);
  assert.equal(allocator.findEarliest("doc", 1, 61, 60), null, "no 60-min window inside [1,61)");
});

test("query does not consume capacity and respects query bounds", () => {
  const allocator = new SlotAllocator();
  allocator.addDoctor("doc", [{ start: 100, end: 200, capacity: 1 }]);
  for (let i = 0; i < 5; i++) {
    assert.equal(allocator.findEarliest("doc", 0, 500, 30), 100, "query is idempotent");
  }
  assert.equal(allocator.findEarliest("doc", 105, 500, 30), 105, "starts need not align");
  assert.equal(allocator.findEarliest("doc", 0, 130, 60), null, "window must fit in query range");
  assert.equal(allocator.findEarliest("doc", 0, 160, 60), 100);
  assert.equal(allocator.findEarliest("doc", 140, 150, 15), null, "range shorter than duration");
});

test("failed booking leaves no residue; cancel releases exactly once", () => {
  const allocator = new SlotAllocator();
  allocator.addDoctor("doc", [{ start: 0, end: 60, capacity: 1 }]);
  const id = allocator.book("doc", 0, 60);
  assert.ok(id !== null);
  assert.equal(allocator.book("doc", 0, 60), null);
  assert.equal(allocator.book("doc", 15, 15), null);
  assert.equal(allocator.cancel("no-such-id"), false);
  assert.equal(allocator.cancel(id as string), true);
  assert.equal(allocator.cancel(id as string), false, "double cancel must not add capacity");
  assert.equal(allocator.book("doc", 0, 60) !== null, true, "capacity restored exactly once");
});

test("validation: unknown doctor, bad duration, duplicate doctor, bad calendar", () => {
  const allocator = new SlotAllocator();
  assert.throws(() => allocator.findEarliest("ghost", 0, 100, 15));
  assert.throws(() => allocator.book("ghost", 0, 15));
  allocator.addDoctor("doc", [{ start: 0, end: 100, capacity: 1 }]);
  assert.throws(() => allocator.addDoctor("doc", []));
  assert.throws(() => allocator.book("doc", 0, 45 as unknown as Duration));
  assert.throws(() => allocator.findEarliest("doc", 0, 100, 7 as unknown as Duration));
  assert.throws(() => allocator.book("doc", 1.5, 15));
  assert.throws(() => allocator.findEarliest("doc", 100, 50, 15));
  const other = new SlotAllocator();
  assert.throws(() =>
    other.addDoctor("bad", [
      { start: 0, end: 60, capacity: 1 },
      { start: 30, end: 90, capacity: 1 },
    ]),
  );
  assert.throws(() => other.addDoctor("bad", [{ start: 0, end: 60, capacity: 0 }]));
  assert.throws(() => other.addDoctor("bad", [{ start: 0, end: 60, capacity: 9 }]));
  assert.throws(() => other.addDoctor("bad", [{ start: 60, end: 60, capacity: 1 }]));
});

test("exhaustive small-timeline agreement with per-minute brute force", () => {
  const calendars: CalendarSegment[][] = [
    [{ start: 0, end: 48, capacity: 1 }],
    [
      { start: 0, end: 24, capacity: 2 },
      { start: 24, end: 48, capacity: 1 },
    ],
    [
      { start: 0, end: 16, capacity: 3 },
      { start: 32, end: 64, capacity: 1 },
      { start: 64, end: 80, capacity: 2 },
    ],
    [
      { start: 4, end: 20, capacity: 1 },
      { start: 20, end: 36, capacity: 2 },
      { start: 36, end: 52, capacity: 3 },
      { start: 52, end: 68, capacity: 1 },
    ],
  ];
  for (const segments of calendars) {
    const allocator = new SlotAllocator();
    const brute = new BruteForce();
    allocator.addDoctor("d", segments);
    brute.addDoctor("d", segments);
    const horizon = 84;
    // Every possible single booking, then undone, must match brute force.
    for (const duration of DURATIONS) {
      for (let start = 0; start + duration <= horizon; start++) {
        const got = allocator.book("d", start, duration);
        const want = brute.book("d", start, duration);
        assert.equal(got !== null, want !== null, `book(${start}, ${duration})`);
        if (got !== null && want !== null) {
          assert.equal(allocator.cancel(got), true);
          assert.equal(brute.cancel(want), true);
        }
      }
    }
    // All query ranges must agree on the pristine calendar.
    for (const duration of DURATIONS) {
      for (let qs = 0; qs <= horizon; qs++) {
        for (let qe = qs; qe <= horizon; qe += 3) {
          assert.equal(
            allocator.findEarliest("d", qs, qe, duration),
            brute.findEarliest("d", qs, qe, duration),
            `findEarliest(${qs}, ${qe}, ${duration}) on ${JSON.stringify(segments)}`,
          );
        }
      }
    }
  }
});

test("random operation sequences agree with brute force on a small timeline", () => {
  const rng = new Rng(20261005);
  for (let trial = 0; trial < 30; trial++) {
    const segmentCount = rng.int(1, 5);
    const segments: CalendarSegment[] = [];
    let cursor = rng.int(0, 10);
    for (let i = 0; i < segmentCount; i++) {
      const length = rng.int(5, 60);
      segments.push({ start: cursor, end: cursor + length, capacity: rng.int(1, 9) });
      cursor += length + rng.int(0, 20); // sometimes leave unopened gaps
    }
    const horizon = cursor + 30;
    const allocator = new SlotAllocator();
    const brute = new BruteForce();
    allocator.addDoctor("d", segments);
    brute.addDoctor("d", segments);
    const liveIds: Array<[string, string]> = []; // [allocatorId, bruteId]
    for (let op = 0; op < 400; op++) {
      const kind = rng.int(0, 10);
      if (kind < 4) {
        const duration = rng.pick(DURATIONS);
        const start = rng.int(0, horizon);
        const got = allocator.book("d", start, duration);
        const want = brute.book("d", start, duration);
        assert.equal(got !== null, want !== null, `book(${start}, ${duration}) trial ${trial}`);
        if (got !== null && want !== null) liveIds.push([got, want]);
      } else if (kind < 7 && liveIds.length > 0) {
        const index = rng.int(0, liveIds.length);
        const [allocatorId, bruteId] = liveIds.splice(index, 1)[0] as [string, string];
        assert.equal(allocator.cancel(allocatorId), true);
        assert.equal(brute.cancel(bruteId), true);
        // Occasionally try cancelling the same id again.
        if (rng.int(0, 3) === 0) {
          assert.equal(allocator.cancel(allocatorId), false);
          assert.equal(brute.cancel(bruteId), false);
        }
      } else {
        const duration = rng.pick(DURATIONS);
        const qs = rng.int(0, horizon);
        const qe = qs + rng.int(0, horizon - qs);
        assert.equal(
          allocator.findEarliest("d", qs, qe, duration),
          brute.findEarliest("d", qs, qe, duration),
          `findEarliest(${qs}, ${qe}, ${duration}) trial ${trial}`,
        );
      }
    }
    // Cancel everything: queries must return to the pristine-calendar answers.
    for (const [allocatorId, bruteId] of liveIds) {
      assert.equal(allocator.cancel(allocatorId), true);
      assert.equal(brute.cancel(bruteId), true);
    }
    const fresh = new SlotAllocator();
    fresh.addDoctor("d", segments);
    for (let q = 0; q < 50; q++) {
      const duration = rng.pick(DURATIONS);
      const qs = rng.int(0, horizon);
      const qe = qs + rng.int(0, horizon - qs);
      assert.equal(allocator.findEarliest("d", qs, qe, duration), fresh.findEarliest("d", qs, qe, duration));
      assert.equal(allocator.findEarliest("d", qs, qe, duration), brute.findEarliest("d", qs, qe, duration));
    }
  }
});
