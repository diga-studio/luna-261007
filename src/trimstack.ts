import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  deleteFile,
  listArchiveDir,
  readArchive,
  writeArchiveAtomic,
} from './archive.js';
import { HotStore } from './db.js';
import {
  ARCHIVE_WINDOW_HOURS,
  CrashHook,
  HOT_HOURS,
  MetricInput,
  RETENTION_HOURS,
  StatsResult,
  TrimStackOptions,
} from './types.js';

const DB_FILE = 'metrics.db';
const ARCHIVE_DIR = 'archives';

interface WindowPlan {
  windowStart: number;
  newFile: string | null;
  oldFile: string | null;
}

function windowOf(hour: number): number {
  return Math.floor(hour / ARCHIVE_WINDOW_HOURS) * ARCHIVE_WINDOW_HOURS;
}

/**
 * Hourly metrics archival store.
 * Hot data and archival metadata live in SQLite; cold data lives in
 * local lossless compressed archive files. All methods are designed to
 * be called serially.
 */
export class TrimStack {
  private readonly store: HotStore;
  private readonly archiveDir: string;
  private readonly crashHook: CrashHook | undefined;
  private currentT: number;

  private constructor(store: HotStore, archiveDir: string, t: number, crashHook?: CrashHook) {
    this.store = store;
    this.archiveDir = archiveDir;
    this.currentT = t;
    this.crashHook = crashHook;
  }

  /** Open (or create) a store. On first creation `initialT` is required. */
  static open(options: TrimStackOptions): TrimStack {
    const dir = options.dir;
    fs.mkdirSync(path.join(dir, ARCHIVE_DIR), { recursive: true });
    const store = new HotStore(path.join(dir, DB_FILE));
    const archiveDir = path.join(dir, ARCHIVE_DIR);
    try {
      let t = store.getT();
      if (t === null) {
        if (options.initialT === undefined || !Number.isInteger(options.initialT)) {
          throw new Error('initialT (integer hour) is required when creating a store');
        }
        t = options.initialT;
        store.transaction(() => store.setT(t as number));
      }
      const ts = new TrimStack(store, archiveDir, t, options.crashHook);
      ts.recover();
      return ts;
    } catch (err) {
      store.close();
      throw err;
    }
  }

  /** Current business hour T. */
  get t(): number {
    return this.currentT;
  }

  private retentionStart(): number {
    return this.currentT - RETENTION_HOURS;
  }

  private coldEnd(): number {
    return this.currentT - HOT_HOURS;
  }

  private hook(point: string): void {
    if (this.crashHook) this.crashHook(point);
  }

  /**
   * Recovery, idempotent and safe to interrupt at any point:
   * remove archive files not referenced by metadata (temp files and
   * generations from uncommitted maintenance), then files whose deletion
   * was committed but not yet carried out.
   */
  private recover(): void {
    this.hook('recover.start');
    const referenced = new Set(this.store.listArchives().map((a) => a.file));
    for (const name of listArchiveDir(this.archiveDir)) {
      this.hook('recover.sweepOrphan');
      if (!referenced.has(name)) {
        deleteFile(this.archiveDir, name);
      }
    }
    this.hook('recover.orphansSwept');
    for (const name of this.store.listPendingDeletes()) {
      this.hook('recover.sweepPending');
      deleteFile(this.archiveDir, name);
      this.store.removePendingDelete(name);
    }
    this.hook('recover.pendingSwept');
  }

  /** Atomically write a batch of hourly metrics. */
  writeBatch(records: MetricInput[]): void {
    const t = this.currentT;
    const lo = this.retentionStart();
    const accepted: MetricInput[] = [];
    for (const r of records) {
      if (!Number.isInteger(r.revision) || r.revision < 0) {
        throw new Error(`invalid revision: ${r.revision}`);
      }
      if (!Number.isInteger(r.utilization) || r.utilization < 0 || r.utilization > 10000) {
        throw new Error(`invalid utilization: ${r.utilization}`);
      }
      if (!Number.isInteger(r.hour)) {
        throw new Error(`invalid hour: ${r.hour}`);
      }
      // Expired hours are ignored even with a higher revision; hours at or
      // after T are outside the contract and ignored as well.
      if (r.hour < lo || r.hour >= t) continue;
      accepted.push(r);
    }
    this.hook('write.validated');
    this.store.transaction(() => {
      this.store.upsertBatch(accepted);
      this.hook('write.inTransaction');
    });
    this.hook('write.committed');
  }

  /** Advance business time to newT and perform archival maintenance atomically. */
  maintain(newT: number): void {
    if (!Number.isInteger(newT)) {
      throw new Error(`invalid newT: ${newT}`);
    }
    if (newT < this.currentT) {
      throw new Error(`newT (${newT}) must not be less than current T (${this.currentT})`);
    }
    if (newT === this.currentT) {
      return; // retry of an already-confirmed maintenance: no-op
    }
    const coldStart = newT - RETENTION_HOURS;
    const coldEnd = newT - HOT_HOURS;

    // Phase 1: build new archive generations for every window intersecting
    // the cold range, merging existing archive content with hot rows.
    const plans: WindowPlan[] = [];
    for (let w = windowOf(coldStart); w < coldEnd; w += ARCHIVE_WINDOW_HOURS) {
      const validLo = Math.max(w, coldStart);
      const validHi = Math.min(w + ARCHIVE_WINDOW_HOURS, coldEnd);
      const hotRows = this.store.selectRange(validLo, validHi);
      const oldFile = this.store.getArchive(w);
      const windowFullyCold = w >= coldStart && w + ARCHIVE_WINDOW_HOURS <= coldEnd;
      if (hotRows.length === 0 && oldFile !== null && windowFullyCold) {
        continue; // nothing can change for this window
      }
      const merged = new Map<string, MetricInput>();
      if (oldFile !== null) {
        for (const r of readArchive(path.join(this.archiveDir, oldFile))) {
          if (r.hour >= validLo && r.hour < validHi) {
            merged.set(`${r.resource}${r.hour}`, r);
          }
        }
      }
      for (const r of hotRows) {
        const key = `${r.resource}${r.hour}`;
        const prev = merged.get(key);
        if (prev === undefined || r.revision > prev.revision) {
          merged.set(key, r);
        }
      }
      const records = [...merged.values()].sort((a, b) => a.hour - b.hour || a.resource.localeCompare(b.resource));
      const newFile = records.length > 0 ? writeArchiveAtomic(this.archiveDir, w, records) : null;
      plans.push({ windowStart: w, newFile, oldFile });
    }
    this.hook('maintain.filesWritten');

    // Phase 2: one SQLite transaction flips metadata, hot data and T.
    this.store.transaction(() => {
      for (const plan of plans) {
        if (plan.newFile !== null) {
          this.store.putArchive(plan.windowStart, plan.newFile);
        } else {
          this.store.removeArchive(plan.windowStart);
        }
        if (plan.oldFile !== null && plan.oldFile !== plan.newFile) {
          this.store.addPendingDelete(plan.oldFile);
        }
      }
      // Windows whose entire content has expired.
      for (const a of this.store.listArchives()) {
        if (a.windowStart + ARCHIVE_WINDOW_HOURS <= coldStart) {
          this.store.removeArchive(a.windowStart);
          this.store.addPendingDelete(a.file);
        }
      }
      // Archived cold rows and expired rows leave the hot store.
      this.store.deleteBefore(coldEnd);
      this.store.setT(newT);
      this.hook('maintain.inTransaction');
    });
    this.currentT = newT;
    this.hook('maintain.committed');

    // Phase 3: carry out committed file deletions. Interrupting here is
    // safe: pending deletes are replayed on the next open.
    for (const name of this.store.listPendingDeletes()) {
      this.hook('maintain.sweepFile');
      deleteFile(this.archiveDir, name);
      this.store.removePendingDelete(name);
    }
    this.hook('maintain.swept');
  }

  /** Statistics for one resource over [startHour, endHour), clamped to retention. */
  query(resource: string, startHour: number, endHour: number): StatsResult {
    const lo = Math.max(startHour, this.retentionStart());
    const hi = Math.min(endHour, this.currentT);
    const best = new Map<number, MetricInput>();
    if (lo < hi) {
      const consider = (r: MetricInput): void => {
        if (r.hour < lo || r.hour >= hi) return;
        const prev = best.get(r.hour);
        if (prev === undefined || r.revision > prev.revision) {
          best.set(r.hour, r);
        }
      };
      for (const r of this.store.selectResource(resource, lo, hi)) {
        consider(r);
      }
      for (let w = windowOf(lo); w < hi; w += ARCHIVE_WINDOW_HOURS) {
        const file = this.store.getArchive(w);
        if (file === null) continue;
        for (const r of readArchive(path.join(this.archiveDir, file))) {
          if (r.resource === resource) consider(r);
        }
      }
    }
    let totalUtilization = 0;
    let maxUtilization = 0;
    for (const r of best.values()) {
      totalUtilization += r.utilization;
      if (r.utilization > maxUtilization) maxUtilization = r.utilization;
    }
    return { hours: best.size, totalUtilization, maxUtilization };
  }

  close(): void {
    this.store.close();
  }
}
