import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GpsTracker, type Ping } from "../src/index.js";
import {
  assertMatchesReference,
  dayMs,
  mulberry32,
  referenceDaily,
  shuffle,
} from "./helpers.js";

const HISTORY = 200_000;
const BATCH = 2_000;
const LATE = 2_000;
const DEVICES = ["dev-1", "dev-2", "dev-3", "dev-4"];
const EMP = "emp-perf";
const BASE = dayMs("2024-01-01");
const STEP_MS = 60_000;

function historyPing(rand: () => number, seq: number, i: number, deviceIdx: number): Ping {
  // Random walk per device so distances are non-trivial.
  const wobble = rand() * 0.002;
  return {
    pingId: `h-${seq.toString(36)}`,
    employeeId: EMP,
    deviceId: DEVICES[deviceIdx],
    timestamp: BASE + i * STEP_MS,
    latitude: 31 + deviceIdx * 0.5 + i * 0.0001 + wobble,
    longitude: 121 + deviceIdx * 0.5 + i * 0.0001 + wobble,
    accuracy: 5 + rand() * 90,
  };
}

test("200k history + 2k shuffled late pings: sub-linear ingest, bounded memory", { timeout: 600_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "gps-ledger-perf-"));
  try {
    const tracker = new GpsTracker(join(dir, "perf.db"));
    const rand = mulberry32(42);
    const all: Ping[] = [];

    // Ingest history in batches of 2000 (never as one call).
    const perDevice = HISTORY / DEVICES.length;
    let seq = 0;
    const t0 = performance.now();
    for (let start = 0; start < perDevice; start += BATCH / DEVICES.length) {
      const batch: Ping[] = [];
      for (let i = start; i < start + BATCH / DEVICES.length; i++) {
        for (let d = 0; d < DEVICES.length; d++) {
          const p = historyPing(rand, seq++, i, d);
          batch.push(p);
          all.push(p);
        }
      }
      tracker.ingestBatch(batch);
    }
    const historyMs = performance.now() - t0;

    // 2000 late out-of-order pings at half-minute offsets in the past.
    const late: Ping[] = [];
    const used = new Set<string>();
    while (late.length < LATE) {
      const d = Math.floor(rand() * DEVICES.length);
      const i = Math.floor(rand() * perDevice);
      const key = `${d}:${i}`;
      if (used.has(key)) continue;
      used.add(key);
      late.push({
        pingId: `late-${late.length.toString(36)}`,
        employeeId: EMP,
        deviceId: DEVICES[d],
        timestamp: BASE + i * STEP_MS + STEP_MS / 2,
        latitude: 31 + d * 0.5 + i * 0.0001 + 0.001,
        longitude: 121 + d * 0.5 + i * 0.0001 + 0.001,
        accuracy: 20,
      });
    }
    shuffle(late, rand);
    all.push(...late);

    if (globalThis.gc) globalThis.gc();
    const memBefore = process.memoryUsage();
    const t1 = performance.now();
    tracker.ingestBatch(late);
    const lateMs = performance.now() - t1;
    const memAfter = process.memoryUsage();
    const heapDeltaMiB = (memAfter.heapUsed - memBefore.heapUsed) / 2 ** 20;
    const rssDeltaMiB = (memAfter.rss - memBefore.rss) / 2 ** 20;

    console.log(
      `history ingest: ${HISTORY} pings in ${historyMs.toFixed(0)}ms ` +
        `(${(historyMs / (HISTORY / BATCH)).toFixed(1)}ms per ${BATCH}-batch); ` +
        `late batch: ${LATE} pings in ${lateMs.toFixed(1)}ms; ` +
        `heap delta ${heapDeltaMiB.toFixed(2)} MiB, rss delta ${rssDeltaMiB.toFixed(2)} MiB`,
    );
    assert.ok(lateMs < 5_000, `late batch too slow: ${lateMs}ms`);
    assert.ok(heapDeltaMiB < 64, `heap growth over budget: ${heapDeltaMiB} MiB`);

    // Full independent recomputation over every ping ever sent.
    const ref = referenceDaily(all);
    const lastDay = BASE + perDevice * STEP_MS;
    const dayStarts: number[] = [];
    for (let d = BASE; d <= lastDay; d += 24 * 3600_000) dayStarts.push(d);
    assertMatchesReference(tracker, ref, [EMP], dayStarts);

    tracker.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
