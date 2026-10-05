import { Ping } from "../src/types";
import { haversineMeters, splitDistanceByDay } from "../src/geo";

const MAX_ACCURACY_FEET = 100;
const MAX_GAP_MS = 30 * 60 * 1000;
const SEP = "\x1f";

export function dayKey(employeeId: string, day: string): string {
  return `${employeeId}${SEP}${day}`;
}

/**
 * Independent full recomputation of daily distances from scratch,
 * used as ground truth in tests.
 */
export function referenceDaily(pings: Ping[]): Map<string, number> {
  const seen = new Set<string>();
  const best = new Map<string, Ping>();
  for (const p of pings) {
    if (seen.has(p.pingId)) continue;
    seen.add(p.pingId);
    if (p.accuracy > MAX_ACCURACY_FEET) continue;
    const key = [p.employeeId, p.deviceId, p.timestamp].join(SEP);
    const cur = best.get(key);
    if (!cur || p.pingId < cur.pingId) best.set(key, p);
  }

  const byDevice = new Map<string, Ping[]>();
  for (const p of best.values()) {
    const key = [p.employeeId, p.deviceId].join(SEP);
    let arr = byDevice.get(key);
    if (!arr) {
      arr = [];
      byDevice.set(key, arr);
    }
    arr.push(p);
  }

  const totals = new Map<string, number>();
  for (const arr of byDevice.values()) {
    arr.sort((a, b) => a.timestamp - b.timestamp);
    for (let i = 0; i + 1 < arr.length; i++) {
      const a = arr[i];
      const b = arr[i + 1];
      if (b.timestamp - a.timestamp > MAX_GAP_MS) continue;
      const dist = haversineMeters(a.latitude, a.longitude, b.latitude, b.longitude);
      for (const [day, share] of splitDistanceByDay(a.timestamp, b.timestamp, dist)) {
        const key = dayKey(a.employeeId, day);
        totals.set(key, (totals.get(key) ?? 0) + share);
      }
    }
  }
  return totals;
}

export function referenceGet(pings: Ping[], employeeId: string, day: string): number {
  return referenceDaily(pings).get(dayKey(employeeId, day)) ?? 0;
}
