import test from "node:test";
import { openTracker } from "../src/index";
import { Ping } from "../src/types";
import { tempDbPath, assertClose } from "./helpers";

const MIN = 60_000;
const DAY1 = "2024-01-01";
const DAY2 = "2024-01-02";

// Independent haversine written directly in the test (does not reuse src/geo).
function expectedMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371008.8;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function ping(pingId: string, timestamp: number, lat: number, lon: number): Ping {
  return {
    pingId,
    employeeId: "emp",
    deviceId: "dev",
    timestamp,
    latitude: lat,
    longitude: lon,
    accuracy: 10,
  };
}

test("midnight split is proportional to milliseconds on each side", () => {
  const tracker = openTracker(tempDbPath());
  const t1 = Date.UTC(2024, 0, 1, 23, 50, 0, 0);
  const t2 = Date.UTC(2024, 0, 2, 0, 10, 0, 0); // 20 min edge, 10 min per side
  tracker.ingestBatch([ping("a", t1, 31.0, 121.0), ping("b", t2, 31.01, 121.02)]);
  const total = expectedMeters(31.0, 121.0, 31.01, 121.02);
  assertClose(tracker.getDaily("emp", DAY1), total / 2, "day1 half");
  assertClose(tracker.getDaily("emp", DAY2), total / 2, "day2 half");
  assertClose(
    tracker.getDaily("emp", DAY1) + tracker.getDaily("emp", DAY2),
    total,
    "sum is the full edge",
  );
  tracker.close();
});

test("30-minute gap counts, 30 minutes + 1ms does not", () => {
  const t0 = Date.UTC(2024, 0, 1, 12, 0, 0, 0);
  const tracker = openTracker(tempDbPath());
  tracker.ingestBatch([
    ping("a", t0, 31.0, 121.0),
    ping("b", t0 + 30 * MIN, 31.01, 121.0),
  ]);
  assertClose(tracker.getDaily("emp", DAY1), expectedMeters(31.0, 121.0, 31.01, 121.0));
  tracker.close();

  const tracker2 = openTracker(tempDbPath());
  tracker2.ingestBatch([
    ping("a", t0, 31.0, 121.0),
    ping("b", t0 + 30 * MIN + 1, 31.01, 121.0),
  ]);
  if (tracker2.getDaily("emp", DAY1) !== 0) {
    throw new Error("gap over 30 minutes must contribute 0");
  }
  tracker2.close();
});

test("accuracy exactly 100 feet counts, 100+epsilon does not", () => {
  const t0 = Date.UTC(2024, 0, 1, 12, 0, 0, 0);
  const tracker = openTracker(tempDbPath());
  tracker.ingestBatch([
    ping("a", t0, 31.0, 121.0),
    { ...ping("b", t0 + 5 * MIN, 31.01, 121.0), accuracy: 100 },
  ]);
  assertClose(tracker.getDaily("emp", DAY1), expectedMeters(31.0, 121.0, 31.01, 121.0));
  tracker.close();

  const tracker2 = openTracker(tempDbPath());
  tracker2.ingestBatch([
    ping("a", t0, 31.0, 121.0),
    { ...ping("b", t0 + 5 * MIN, 31.01, 121.0), accuracy: 100.5 },
  ]);
  if (tracker2.getDaily("emp", DAY1) !== 0) {
    throw new Error("accuracy above 100 feet must be excluded");
  }
  tracker2.close();
});
