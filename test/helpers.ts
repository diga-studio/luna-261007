import { strict as assert } from "node:assert";
import type { Ping } from "../src/index.js";
import { DAY_MS, MAX_GAP_MS, haversineM, splitByDay } from "../src/geo.js";

/** Deterministic PRNG so randomized tests are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(arr: T[], rand: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function dayMs(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

export function dayOfMs(ts: number): number {
  return Math.floor(ts / DAY_MS) * DAY_MS;
}

/**
 * Independent full recomputation: employee -> (dayStartMs -> meters).
 * Recomputes everything from the raw ping list, ignoring ingest history.
 */
export function referenceDaily(pings: Ping[]): Map<string, Map<number, number>> {
  const winners = new Map<string, Ping>();
  for (const p of pings) {
    if (p.accuracy > 100) continue;
    const key = `${p.employeeId} ${p.deviceId} ${p.timestamp}`;
    const cur = winners.get(key);
    if (!cur || p.pingId < cur.pingId) winners.set(key, p);
  }
  const byDevice = new Map<string, Ping[]>();
  for (const p of winners.values()) {
    const dk = `${p.employeeId} ${p.deviceId}`;
    let arr = byDevice.get(dk);
    if (!arr) byDevice.set(dk, (arr = []));
    arr.push(p);
  }
  const result = new Map<string, Map<number, number>>();
  for (const arr of byDevice.values()) {
    arr.sort((a, b) => a.timestamp - b.timestamp);
    for (let i = 1; i < arr.length; i++) {
      const a = arr[i - 1];
      const b = arr[i];
      const gap = b.timestamp - a.timestamp;
      if (gap <= 0 || gap > MAX_GAP_MS) continue;
      const dist = haversineM(a.latitude, a.longitude, b.latitude, b.longitude);
      for (const [dayStart, meters] of splitByDay(a.timestamp, b.timestamp, dist)) {
        let emp = result.get(a.employeeId);
        if (!emp) result.set(a.employeeId, (emp = new Map()));
        emp.set(dayStart, (emp.get(dayStart) ?? 0) + meters);
      }
    }
  }
  return result;
}

/** 1 mm absolute OR 1e-9 relative tolerance. */
export function assertClose(actual: number, expected: number, msg: string): void {
  const diff = Math.abs(actual - expected);
  const ok = diff <= 1e-3 || diff <= 1e-9 * Math.max(Math.abs(actual), Math.abs(expected));
  assert.ok(ok, `${msg}: actual=${actual} expected=${expected} diff=${diff}`);
}

/** Compare a tracker's per-day answers against the reference maps. */
export function assertMatchesReference(
  tracker: { getDaily(employeeId: string, day: string): number },
  ref: Map<string, Map<number, number>>,
  employeeIds: string[],
  dayStarts: number[],
): void {
  for (const emp of employeeIds) {
    const empRef = ref.get(emp);
    for (const dayStart of dayStarts) {
      const expected = empRef?.get(dayStart) ?? 0;
      const day = new Date(dayStart).toISOString().slice(0, 10);
      assertClose(tracker.getDaily(emp, day), expected, `${emp} ${day}`);
    }
  }
}
