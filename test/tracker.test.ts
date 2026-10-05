import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GpsTracker, type Ping } from "../src/index.js";
import {
  assertClose,
  assertMatchesReference,
  dayMs,
  mulberry32,
  referenceDaily,
  shuffle,
} from "./helpers.js";

function tempDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "gps-ledger-"));
  return {
    path: join(dir, "test.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function ping(partial: Partial<Ping> & Pick<Ping, "pingId" | "timestamp">): Ping {
  return {
    employeeId: "emp1",
    deviceId: "dev1",
    latitude: 31.2,
    longitude: 121.5,
    accuracy: 10,
    ...partial,
  };
}

test("cross-midnight gap filled by late points; duplicates and bad accuracy are no-ops", () => {
  const { path, cleanup } = tempDb();
  try {
    const tracker = new GpsTracker(path);
    const t = (iso: string) => Date.parse(iso + "Z");
    // Original endpoints: 2h gap across midnight -> contributes nothing.
    const a = ping({ pingId: "p-a", timestamp: t("2024-03-09T23:05:00"), longitude: 121.50 });
    const b = ping({ pingId: "p-b", timestamp: t("2024-03-10T01:05:00"), longitude: 121.54 });
    tracker.ingestBatch([a, b]);
    assert.equal(tracker.getDaily("emp1", "2024-03-09"), 0);
    assert.equal(tracker.getDaily("emp1", "2024-03-10"), 0);

    // Late points split the 2h hole into valid <=30min edges, one straddling midnight.
    const c = ping({ pingId: "p-c", timestamp: t("2024-03-09T23:30:00"), longitude: 121.51 });
    const d = ping({ pingId: "p-d", timestamp: t("2024-03-09T23:55:00"), longitude: 121.52 });
    const e = ping({ pingId: "p-e", timestamp: t("2024-03-10T00:20:00"), longitude: 121.53 });
    tracker.ingestBatch([e, c, d]); // deliberately out of order

    const all = [a, b, c, d, e];
    const ref = referenceDaily(all);
    const empRef = ref.get("emp1")!;
    const day1 = empRef.get(dayMs("2024-03-09"))!;
    const day2 = empRef.get(dayMs("2024-03-10"))!;
    assert.ok(day1 > 0 && day2 > 0, "both days must gain distance");
    assertClose(tracker.getDaily("emp1", "2024-03-09"), day1, "day1");
    assertClose(tracker.getDaily("emp1", "2024-03-10"), day2, "day2");

    // Re-ingest duplicates (different batching) plus low-accuracy points: nothing changes.
    tracker.ingestBatch([b, a]);
    tracker.ingestBatch([d, c, e]);
    tracker.ingestBatch([
      ping({ pingId: "p-bad1", timestamp: t("2024-03-09T23:40:00"), longitude: 122.5, accuracy: 101 }),
      ping({ pingId: "p-bad2", timestamp: t("2024-03-10T00:05:00"), longitude: 120.5, accuracy: 5000 }),
    ]);
    assertClose(tracker.getDaily("emp1", "2024-03-09"), day1, "day1 after noise");
    assertClose(tracker.getDaily("emp1", "2024-03-10"), day2, "day2 after noise");
    tracker.close();
  } finally {
    cleanup();
  }
});

test("late smaller pingId replaces same-timestamp point; devices never connect", () => {
  const { path, cleanup } = tempDb();
  try {
    const tracker = new GpsTracker(path);
    const t0 = dayMs("2024-06-01") + 12 * 3600_000;
    const p1 = ping({ pingId: "p-1", timestamp: t0, longitude: 121.50 });
    const p2big = ping({ pingId: "z-9", timestamp: t0 + 10 * 60_000, longitude: 121.51 });
    const p3 = ping({ pingId: "p-3", timestamp: t0 + 20 * 60_000, longitude: 121.52 });
    // Second device, interleaved in time; must not form edges with dev1.
    const q1 = ping({ pingId: "q-1", deviceId: "dev2", timestamp: t0 + 5 * 60_000, latitude: 39.9, longitude: 116.4 });
    const q2 = ping({ pingId: "q-2", deviceId: "dev2", timestamp: t0 + 15 * 60_000, latitude: 39.9, longitude: 116.45 });
    tracker.ingestBatch([p1, p2big, p3, q1, q2]);

    // The winning point for dev1 @ t0+10min arrives last with a smaller pingId.
    const p2small = ping({ pingId: "a-0", timestamp: t0 + 10 * 60_000, longitude: 121.60 });
    tracker.ingestBatch([p2small]);

    const ref = referenceDaily([p1, p2big, p3, q1, q2, p2small]);
    assertMatchesReference(tracker, ref, ["emp1"], [dayMs("2024-06-01")]);
    // Sanity: replacement must actually change the total vs. the old point.
    const stale = referenceDaily([p1, p2big, p3, q1, q2]);
    const day = dayMs("2024-06-01");
    assert.notEqual(
      ref.get("emp1")!.get(day)!.toFixed(6),
      stale.get("emp1")!.get(day)!.toFixed(6),
      "replacement must change the daily total",
    );
    tracker.close();
  } finally {
    cleanup();
  }
});

test("randomized data matches full reference across shuffles and batch splits", () => {
  const rand = mulberry32(20261005);
  const base = dayMs("2024-01-15");
  const employees = ["emp-a", "emp-b"];
  const devices = ["dev-1", "dev-2", "dev-3"];
  const all: Ping[] = [];
  let seq = 0;
  const nextId = () => `id-${(seq++).toString(36).padStart(4, "0")}`;

  for (let i = 0; i < 400; i++) {
    all.push({
      pingId: nextId(),
      employeeId: employees[Math.floor(rand() * employees.length)],
      deviceId: devices[Math.floor(rand() * devices.length)],
      timestamp: base + Math.floor(rand() * 2 * 24 * 3600_000),
      latitude: 20 + rand() * 20,
      longitude: 100 + rand() * 20,
      accuracy: rand() < 0.15 ? 101 + rand() * 400 : rand() * 100,
    });
  }
  // Same-timestamp collisions with competing pingIds.
  for (let i = 0; i < 40; i++) {
    const src = all[Math.floor(rand() * all.length)];
    all.push({ ...src, pingId: nextId(), latitude: src.latitude + rand() });
  }
  // Exact duplicates.
  for (let i = 0; i < 40; i++) {
    all.push(all[Math.floor(rand() * all.length)]);
  }

  const ref = referenceDaily(all);
  const dayStarts = [base, base + 24 * 3600_000, base + 2 * 24 * 3600_000];

  for (let trial = 0; trial < 5; trial++) {
    const { path, cleanup } = tempDb();
    try {
      const tracker = new GpsTracker(path);
      const shuffled = shuffle([...all], rand);
      let cursor = 0;
      while (cursor < shuffled.length) {
        const size = 1 + Math.floor(rand() * 97);
        tracker.ingestBatch(shuffled.slice(cursor, cursor + size));
        cursor += size;
      }
      assertMatchesReference(tracker, ref, employees, dayStarts);
      tracker.close();
    } finally {
      cleanup();
    }
  }
});

test("results persist across close and reopen", () => {
  const { path, cleanup } = tempDb();
  try {
    const t0 = dayMs("2024-07-04") + 8 * 3600_000;
    const pings = [
      ping({ pingId: "k-1", timestamp: t0, longitude: 121.50 }),
      ping({ pingId: "k-2", timestamp: t0 + 10 * 60_000, longitude: 121.51 }),
      ping({ pingId: "k-3", timestamp: t0 + 20 * 60_000, longitude: 121.52 }),
    ];
    const expected = referenceDaily(pings).get("emp1")!.get(dayMs("2024-07-04"))!;
    const first = new GpsTracker(path);
    first.ingestBatch(pings);
    first.close();

    const second = new GpsTracker(path);
    assertClose(second.getDaily("emp1", "2024-07-04"), expected, "reopened");
    // Late point after reopen still merges correctly.
    second.ingestBatch([ping({ pingId: "k-4", timestamp: t0 + 30 * 60_000, longitude: 121.53 })]);
    const expected2 = referenceDaily([
      ...pings,
      ping({ pingId: "k-4", timestamp: t0 + 30 * 60_000, longitude: 121.53 }),
    ]).get("emp1")!.get(dayMs("2024-07-04"))!;
    assertClose(second.getDaily("emp1", "2024-07-04"), expected2, "reopened + late");
    second.close();
  } finally {
    cleanup();
  }
});
