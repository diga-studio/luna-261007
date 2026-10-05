import test from "node:test";
import { openTracker } from "../src/index";
import { Ping } from "../src/types";
import { referenceDaily } from "./reference";
import { tempDbPath, assertClose, rng, shuffle } from "./helpers";

const MIB = 1024 * 1024;

test("perf: 200k history + 2k shuffled late pings stay fast and correct", { timeout: 300_000 }, () => {
  const rand = rng(7);
  const employeeId = "perf-emp";
  const devices = ["pd1", "pd2", "pd3", "pd4"];
  const base = Date.UTC(2024, 4, 1, 0, 0, 0, 0);
  const HISTORY = 200_000;
  const LATE = 2_000;
  const BATCH = 2_000;

  // Device cursors for a random-walk trajectory; history is generated in
  // batches and fed straight to the tracker, never held as one big call.
  const cursors = devices.map((d, i) => ({
    deviceId: d,
    ts: base + i * 45_000,
    lat: 31.0 + i * 0.5,
    lon: 121.0 + i * 0.5,
  }));
  let id = 0;
  const nextId = () => `h-${String(id++).padStart(7, "0")}`;
  const makeHistorical = (): Ping => {
    const c = cursors[Math.floor(rand() * cursors.length)];
    c.ts += 30_000 + Math.floor(rand() * 60_000);
    c.lat += (rand() - 0.5) * 0.002;
    c.lon += (rand() - 0.5) * 0.002;
    return {
      pingId: nextId(),
      employeeId,
      deviceId: c.deviceId,
      timestamp: c.ts,
      latitude: c.lat,
      longitude: c.lon,
      accuracy: rand() < 0.05 ? 100 + rand() * 400 : rand() * 100,
    };
  };

  const tracker = openTracker(tempDbPath());
  const memBefore = process.memoryUsage();
  const t0 = performance.now();
  const history: Ping[] = [];
  let ingested = 0;
  while (ingested < HISTORY) {
    const batch: Ping[] = [];
    for (let i = 0; i < BATCH && ingested < HISTORY; i++, ingested++) {
      batch.push(makeHistorical());
    }
    tracker.ingestBatch(batch);
    history.push(...batch);
  }
  const historyMs = performance.now() - t0;
  const spanEnd = Math.max(...cursors.map((c) => c.ts));

  // 2000 late, out-of-order pings scattered through the existing history.
  const late: Ping[] = [];
  for (let i = 0; i < LATE; i++) {
    const c = cursors[Math.floor(rand() * cursors.length)];
    late.push({
      pingId: nextId(),
      employeeId,
      deviceId: c.deviceId,
      timestamp: base + Math.floor(rand() * (spanEnd - base)),
      latitude: 31.0 + rand() * 2,
      longitude: 121.0 + rand() * 2,
      accuracy: rand() < 0.1 ? 100 + rand() * 400 : rand() * 100,
    });
  }
  const shuffledLate = shuffle(late, rng(99));
  global.gc?.();
  const memBeforeLate = process.memoryUsage();
  const t1 = performance.now();
  tracker.ingestBatch(shuffledLate);
  const lateMs = performance.now() - t1;
  global.gc?.();
  const memAfterLate = process.memoryUsage();

  // Library-side memory must not grow with traffic: ingest 20k more pings
  // without retaining them and confirm RSS stays flat.
  const discard: Ping[] = [];
  for (let i = 0; i < 20_000; i++) discard.push(makeHistorical());
  tracker.ingestBatch(discard);
  global.gc?.();
  const memAfterMore = process.memoryUsage();
  const libLateMiB = (memAfterLate.rss - memBeforeLate.rss) / MIB;
  const libSteadyMiB = (memAfterMore.rss - memAfterLate.rss) / MIB;

  const all = history.concat(shuffledLate, discard);
  const ref = referenceDaily(all);
  let checked = 0;
  for (const [key, expected] of ref) {
    const sep = key.indexOf("\x1f");
    const emp = key.slice(0, sep);
    const day = key.slice(sep + 1);
    assertClose(tracker.getDaily(emp, day), expected, `daily ${emp}/${day}`);
    checked++;
  }
  console.log(
    [
      `perf: history=${HISTORY} in ${historyMs.toFixed(0)}ms`,
      `late=${LATE} in ${lateMs.toFixed(1)}ms`,
      `days checked=${checked}`,
      `rss total=${((memAfterLate.rss - memBefore.rss) / MIB).toFixed(1)}MiB`,
      `lib late=${libLateMiB.toFixed(1)}MiB`,
      `lib steady=${libSteadyMiB.toFixed(1)}MiB`,
    ].join(" | "),
  );
  // The late batch must not scan history: 2000 pings should cost milliseconds,
  // not grow with the 200k already stored.
  assertOk(lateMs < 10_000, `late ingest too slow: ${lateMs}ms`);
  assertOk(libLateMiB < 64, `library used ${libLateMiB.toFixed(1)}MiB for late batch`);
  assertOk(libSteadyMiB < 64, `library grew ${libSteadyMiB.toFixed(1)}MiB for 20k extra pings`);
  tracker.close();
});

function assertOk(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}
