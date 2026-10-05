import test from "node:test";
import assert from "node:assert/strict";
import { openTracker } from "../src/index";
import { Ping } from "../src/types";
import { referenceDaily, dayKey } from "./reference";
import { tempDbPath, assertClose, rng, shuffle } from "./helpers";

const MIN = 60_000;
const T0 = Date.UTC(2024, 0, 1, 23, 30, 0, 0); // 2024-01-01T23:30:00Z
const DAY1 = "2024-01-01";
const DAY2 = "2024-01-02";

function ping(partial: Partial<Ping> & { pingId: string }): Ping {
  return {
    employeeId: "emp1",
    deviceId: "dev1",
    timestamp: T0,
    latitude: 31.0,
    longitude: 121.0,
    accuracy: 10,
    ...partial,
  };
}

test("cross-midnight gap filled by late point; duplicates and bad accuracy are no-ops", () => {
  const tracker = openTracker(tempDbPath());
  // 60-minute gap across midnight: contributes nothing yet.
  const a = ping({ pingId: "p-a", timestamp: T0, latitude: 31.0, longitude: 121.0 });
  const b = ping({ pingId: "p-b", timestamp: T0 + 60 * MIN, latitude: 31.02, longitude: 121.0 });
  tracker.ingestBatch([a, b]);
  assert.equal(tracker.getDaily("emp1", DAY1), 0);
  assert.equal(tracker.getDaily("emp1", DAY2), 0);

  // Late point in the middle turns the 60-min hole into two valid edges.
  const c = ping({ pingId: "p-c", timestamp: T0 + 30 * MIN, latitude: 31.01, longitude: 121.0 });
  tracker.ingestBatch([c]);
  const all = [a, b, c];
  const ref = referenceDaily(all);
  assertClose(tracker.getDaily("emp1", DAY1), ref.get(dayKey("emp1", DAY1)) ?? 0);
  assertClose(tracker.getDaily("emp1", DAY2), ref.get(dayKey("emp1", DAY2)) ?? 0);
  assert.ok(tracker.getDaily("emp1", DAY1) > 0, "day1 gets its share of the midnight-crossing edge");
  assert.ok(tracker.getDaily("emp1", DAY2) > 0, "day2 gets distance too");

  // Re-ingesting everything (any order, any split) must not double count.
  tracker.ingestBatch([c, a]);
  tracker.ingestBatch([b, a, c]);
  assertClose(tracker.getDaily("emp1", DAY1), ref.get(dayKey("emp1", DAY1)) ?? 0);
  assertClose(tracker.getDaily("emp1", DAY2), ref.get(dayKey("emp1", DAY2)) ?? 0);

  // Low-accuracy points never enter the trajectory, even with small pingIds.
  const bad = ping({ pingId: "a-bad", timestamp: T0 + 15 * MIN, latitude: 35.0, longitude: 140.0, accuracy: 100.0001 });
  const badEdge = ping({ pingId: "a-bad2", timestamp: T0 + 45 * MIN, latitude: 35.0, longitude: 140.0, accuracy: 500 });
  tracker.ingestBatch([bad, badEdge]);
  // A larger pingId at an existing timestamp loses dedup and changes nothing.
  const loser = ping({ pingId: "z-loser", timestamp: T0 + 30 * MIN, latitude: 40.0, longitude: 130.0 });
  tracker.ingestBatch([loser]);
  assertClose(tracker.getDaily("emp1", DAY1), ref.get(dayKey("emp1", DAY1)) ?? 0);
  assertClose(tracker.getDaily("emp1", DAY2), ref.get(dayKey("emp1", DAY2)) ?? 0);
  tracker.close();
});

test("late smaller pingId replaces same-timestamp point; devices never connect", () => {
  const tracker = openTracker(tempDbPath());
  const p1 = ping({ pingId: "p-1", timestamp: T0, latitude: 31.0, longitude: 121.0 });
  const p2 = ping({ pingId: "p-2", timestamp: T0 + 10 * MIN, latitude: 31.01, longitude: 121.0 });
  const p3 = ping({ pingId: "p-3", timestamp: T0 + 20 * MIN, latitude: 31.02, longitude: 121.0 });
  tracker.ingestBatch([p1, p2, p3]);
  const before = tracker.getDaily("emp1", DAY1);
  assert.ok(before > 0);

  // Same timestamp as p2, smaller pingId, different location: replaces p2 and
  // corrects contributions on both sides (p1->p2 and p2->p3).
  const p2r = ping({ pingId: "a-2", timestamp: T0 + 10 * MIN, latitude: 31.015, longitude: 121.005 });
  tracker.ingestBatch([p2r]);
  const afterReplace = tracker.getDaily("emp1", DAY1);
  assert.ok(Math.abs(afterReplace - before) > 1e-6, "replacement changed the total");
  assertClose(afterReplace, referenceDaily([p1, p2r, p3]).get(dayKey("emp1", DAY1)) ?? 0);

  // Points of a second device interleaved in time must not connect to dev1.
  const q1 = ping({ pingId: "q-1", deviceId: "dev2", timestamp: T0 + 5 * MIN, latitude: 31.005, longitude: 121.0 });
  tracker.ingestBatch([q1]);
  assertClose(tracker.getDaily("emp1", DAY1), afterReplace, "single point on dev2 adds nothing");
  const q2 = ping({ pingId: "q-2", deviceId: "dev2", timestamp: T0 + 15 * MIN, latitude: 31.006, longitude: 121.0 });
  tracker.ingestBatch([q2]);
  const full = referenceDaily([p1, p2r, p3, q1, q2]);
  assertClose(tracker.getDaily("emp1", DAY1), full.get(dayKey("emp1", DAY1)) ?? 0);
  tracker.close();
});

test("random data: many shuffles and batch splits match full reference", () => {
  const rand = rng(42);
  const employees = ["e1", "e2"];
  const devices = ["d1", "d2", "d3"];
  const base = Date.UTC(2024, 2, 10, 0, 0, 0, 0);
  const spanMs = 3 * 24 * 60 * MIN;
  const pings: Ping[] = [];
  let id = 0;
  const nextId = () => `id-${String(id++).padStart(6, "0")}`;

  for (let i = 0; i < 500; i++) {
    const employeeId = employees[Math.floor(rand() * employees.length)];
    const deviceId = devices[Math.floor(rand() * devices.length)];
    // Cluster timestamps so that same-timestamp collisions happen.
    const timestamp = base + Math.floor(rand() * (spanMs / 1000)) * 1000;
    pings.push({
      pingId: nextId(),
      employeeId,
      deviceId,
      timestamp,
      latitude: 20 + rand() * 20,
      longitude: 100 + rand() * 20,
      accuracy: rand() < 0.2 ? 100 + rand() * 900 : rand() * 100,
    });
  }
  // Duplicate some pings (content identical).
  for (let i = 0; i < 100; i++) {
    pings.push(pings[Math.floor(rand() * 500)]);
  }

  const days = ["2024-03-10", "2024-03-11", "2024-03-12", "2024-03-13"];
  for (const seed of [1, 2, 3, 4, 5]) {
    const r = rng(seed);
    const ordered = shuffle(pings, r);
    const tracker = openTracker(tempDbPath());
    const ingested: Ping[] = [];
    let pos = 0;
    while (pos < ordered.length) {
      const size = 1 + Math.floor(r() * 97);
      const batch = ordered.slice(pos, pos + size);
      pos += size;
      tracker.ingestBatch(batch);
      ingested.push(...batch);
      // After every batch the whole state must equal a full recompute.
      const ref = referenceDaily(ingested);
      for (const employeeId of employees) {
        for (const day of days) {
          assertClose(
            tracker.getDaily(employeeId, day),
            ref.get(dayKey(employeeId, day)) ?? 0,
            `seed=${seed} after ${ingested.length} pings ${employeeId}/${day}`,
          );
        }
      }
    }
    tracker.close();
  }
});

test("persistence: results survive close and reopen", () => {
  const dbPath = tempDbPath();
  const p1 = ping({ pingId: "p-1", timestamp: T0, latitude: 31.0, longitude: 121.0 });
  const p2 = ping({ pingId: "p-2", timestamp: T0 + 10 * MIN, latitude: 31.01, longitude: 121.0 });
  const tracker = openTracker(dbPath);
  tracker.ingestBatch([p1, p2]);
  const expected = tracker.getDaily("emp1", DAY1);
  tracker.close();

  const reopened = openTracker(dbPath);
  assertClose(reopened.getDaily("emp1", DAY1), expected);
  // Duplicates are still recognized after reopen.
  reopened.ingestBatch([p1, p2]);
  assertClose(reopened.getDaily("emp1", DAY1), expected);
  reopened.close();
});

test("empty state returns 0", () => {
  const tracker = openTracker(tempDbPath());
  assert.equal(tracker.getDaily("nobody", DAY1), 0);
  tracker.close();
});
