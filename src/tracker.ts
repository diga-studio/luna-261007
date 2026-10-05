import type { Ping } from "./types.js";
import { Store, type StoredPoint } from "./store.js";
import { MAX_GAP_MS, haversineM, splitByDay } from "./geo.js";

const MAX_ACCURACY_FT = 100;

export class GpsTracker {
  private store: Store;

  constructor(path: string) {
    this.store = new Store(path);
  }

  /** Ingest a batch of pings (any order, duplicates allowed). */
  ingestBatch(pings: Ping[]): void {
    this.store.begin();
    try {
      for (const ping of pings) {
        if (ping.accuracy > MAX_ACCURACY_FT) continue;
        this.applyPing(ping);
      }
      this.store.commit();
    } catch (err) {
      this.store.rollback();
      throw err;
    }
  }

  private applyPing(ping: Ping): void {
    const { employeeId, deviceId, timestamp: ts } = ping;
    const existing = this.store.getPoint(employeeId, deviceId, ts);
    // ASCII byte order == JS code-unit order for ASCII strings.
    if (existing && existing.pingId <= ping.pingId) return;

    const prev = this.store.getPrev(employeeId, deviceId, ts);
    const next = this.store.getNext(employeeId, deviceId, ts);

    if (existing) {
      // A smaller pingId replaces the point at this timestamp:
      // remove the old point's edges on both sides.
      if (prev) this.applyEdge(employeeId, prev, existing, -1);
      if (next) this.applyEdge(employeeId, existing, next, -1);
    } else if (prev && next) {
      // A brand-new point splits the old prev->next adjacency.
      this.applyEdge(employeeId, prev, next, -1);
    }

    const point: StoredPoint = {
      pingId: ping.pingId,
      ts,
      lat: ping.latitude,
      lon: ping.longitude,
    };
    this.store.upsertPoint(employeeId, deviceId, point);
    if (prev) this.applyEdge(employeeId, prev, point, +1);
    if (next) this.applyEdge(employeeId, point, next, +1);
  }

  /** sign=+1 adds the edge's day-split distance, sign=-1 removes it. */
  private applyEdge(
    employeeId: string,
    a: StoredPoint,
    b: StoredPoint,
    sign: 1 | -1,
  ): void {
    const gap = b.ts - a.ts;
    if (gap <= 0 || gap > MAX_GAP_MS) return;
    const dist = haversineM(a.lat, a.lon, b.lat, b.lon);
    if (dist === 0) return;
    for (const [dayStart, meters] of splitByDay(a.ts, b.ts, dist)) {
      this.store.addDaily(employeeId, dayStart, sign * meters);
    }
  }

  /** Accumulated distance in meters for one UTC day ("YYYY-MM-DD"). */
  getDaily(employeeId: string, day: string): number {
    const [y, m, d] = day.split("-").map(Number);
    return this.store.getDaily(employeeId, Date.UTC(y, m - 1, d));
  }

  close(): void {
    this.store.close();
  }
}
