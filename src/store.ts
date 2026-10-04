import * as fs from 'node:fs';
import * as path from 'node:path';
import { MetricsDb } from './db.js';
import { readArchiveFile, removeFileIfExists, writeArchiveFile } from './archive.js';
import { ARCHIVE_CHUNK_HOURS, HOT_HOURS, RETENTION_HOURS } from './constants.js';
import type { CrashHooks, HourlyStats, MetricRecord, StoreOptions } from './types.js';

const DB_FILE = 'metrics.db';
const ARCHIVE_DIR = 'archives';

interface ChunkPlan {
  chunkStart: number;
  chunkEnd: number;
  /** Name of the newly written archive file, or null when the chunk became empty. */
  newFile: string | null;
  /** Ids of active archives replaced by this plan. */
  obsoleteIds: number[];
}

function floorToChunk(hour: number): number {
  return hour - ((hour % ARCHIVE_CHUNK_HOURS) + ARCHIVE_CHUNK_HOURS) % ARCHIVE_CHUNK_HOURS;
}

function validateRecord(rec: MetricRecord): void {
  if (typeof rec.resource !== 'string' || rec.resource.length === 0) {
    throw new Error('metric: resource must be a non-empty string');
  }
  if (!Number.isInteger(rec.hour)) throw new Error('metric: hour must be an integer');
  if (!Number.isInteger(rec.revision) || rec.revision < 0) {
    throw new Error('metric: revision must be a non-negative integer');
  }
  if (!Number.isInteger(rec.cpu) || rec.cpu < 0 || rec.cpu > 10000) {
    throw new Error('metric: cpu must be an integer in [0, 10000]');
  }
}

/** Merges record lists keeping, per (resource, hour), the record with the highest revision. */
function mergeByRevision(lists: MetricRecord[][]): MetricRecord[] {
  const best = new Map<string, MetricRecord>();
  for (const list of lists) {
    for (const rec of list) {
      const key = JSON.stringify([rec.resource, rec.hour]);
      const prev = best.get(key);
      if (prev === undefined || rec.revision > prev.revision) best.set(key, rec);
    }
  }
  return [...best.values()].sort((a, b) => a.hour - b.hour || (a.resource < b.resource ? -1 : 1));
}

export class TrimStackStore {
  private readonly db: MetricsDb;
  private readonly archivesDir: string;
  private readonly hooks: CrashHooks;

  private constructor(db: MetricsDb, archivesDir: string, hooks: CrashHooks) {
    this.db = db;
    this.archivesDir = archivesDir;
    this.hooks = hooks;
  }

  static open(dir: string, options: StoreOptions = {}): TrimStackStore {
    fs.mkdirSync(dir, { recursive: true });
    const archivesDir = path.join(dir, ARCHIVE_DIR);
    fs.mkdirSync(archivesDir, { recursive: true });
    const db = new MetricsDb(path.join(dir, DB_FILE));
    try {
      const stored = db.currentHour;
      if (stored === null) {
        if (options.initialHour === undefined || !Number.isInteger(options.initialHour)) {
          throw new Error('TrimStackStore.open: initialHour (integer) is required for a new store');
        }
        db.transaction(() => db.setCurrentHour(options.initialHour as number));
      } else if (options.initialHour !== undefined && options.initialHour !== stored) {
        throw new Error(
          `TrimStackStore.open: initialHour ${options.initialHour} does not match stored current hour ${stored}`,
        );
      }
      const store = new TrimStackStore(db, archivesDir, options.crashHooks ?? {});
      store.recover();
      return store;
    } catch (err) {
      db.close();
      throw err;
    }
  }

  get currentHour(): number {
    const hour = this.db.currentHour;
    if (hour === null) throw new Error('store not initialized');
    return hour;
  }

  /** Idempotent crash recovery: drop obsolete archive files/rows and sweep unknown files. */
  private recover(): void {
    const obsolete = this.db.listArchives('obsolete');
    for (const row of obsolete) {
      removeFileIfExists(path.join(this.archivesDir, row.file));
      this.hooks.onRecoverDuringCleanup?.();
      this.db.transaction(() => this.db.deleteArchiveRow(row.id));
    }
    const referenced = new Set(this.db.listArchives().map((r) => r.file));
    for (const entry of fs.readdirSync(this.archivesDir)) {
      if (!referenced.has(entry)) {
        removeFileIfExists(path.join(this.archivesDir, entry));
        this.hooks.onRecoverDuringCleanup?.();
      }
    }
  }

  /** Atomically applies a batch of metric samples. */
  writeBatch(records: MetricRecord[]): void {
    const hour = this.currentHour;
    const retainStart = hour - RETENTION_HOURS;
    const hotStart = hour - HOT_HOURS;
    const hot: MetricRecord[] = [];
    const cold: MetricRecord[] = [];
    for (const rec of records) {
      validateRecord(rec);
      if (rec.hour < retainStart || rec.hour >= hour) continue;
      if (rec.hour >= hotStart) hot.push(rec);
      else cold.push(rec);
    }
    this.db.transaction(() => {
      this.db.upsertHot(hot);
      this.db.upsertColdDelta(cold);
      this.hooks.onWriteBatchBeforeCommit?.();
    });
  }

  /** Advances business time to newHour and performs archival maintenance atomically. */
  maintain(newHour: number): void {
    if (!Number.isInteger(newHour)) throw new Error('maintain: newHour must be an integer');
    const hour = this.currentHour;
    if (newHour < hour) throw new Error(`maintain: cannot move time backwards (${newHour} < ${hour})`);
    const retainStart = newHour - RETENTION_HOURS;
    const hotStart = newHour - HOT_HOURS;

    const plans: ChunkPlan[] = [];
    const expiredArchiveIds: number[] = [];

    for (const arch of this.db.listArchives('active')) {
      if (arch.endHour <= retainStart) expiredArchiveIds.push(arch.id);
    }

    const firstChunk = floorToChunk(retainStart);
    for (let cs = firstChunk; cs < hotStart; cs += ARCHIVE_CHUNK_HOURS) {
      const ce = cs + ARCHIVE_CHUNK_HOURS;
      const existing = this.db.activeArchivesOverlapping(cs, ce);
      const delta = this.db.selectColdDeltaRange(cs, ce).filter((r) => r.hour >= retainStart);
      const hot = this.db.selectHotRange(cs, ce);
      const oldRecords = existing.flatMap((a) => readArchiveFile(path.join(this.archivesDir, a.file)));
      const hasExpired = oldRecords.some((r) => r.hour < retainStart);
      const aligned = existing.length === 1 && existing[0]!.startHour === cs && existing[0]!.endHour === ce;
      if (aligned && !hasExpired && delta.length === 0 && hot.length === 0) {
        continue; // untouched chunk: keep its archive as is
      }
      const keptOld = oldRecords.filter((r) => r.hour >= retainStart);
      const merged = mergeByRevision([keptOld, delta, hot]);
      const obsoleteIds = existing.map((a) => a.id);
      if (merged.length === 0) {
        if (obsoleteIds.length > 0) plans.push({ chunkStart: cs, chunkEnd: ce, newFile: null, obsoleteIds });
        continue;
      }
      const newFile = writeArchiveFile(this.archivesDir, cs, ce, merged);
      this.hooks.onMaintainTempFileWritten?.();
      plans.push({ chunkStart: cs, chunkEnd: ce, newFile, obsoleteIds });
      this.hooks.onMaintainFileRenamed?.();
    }

    this.db.transaction(() => {
      for (const plan of plans) {
        if (plan.newFile !== null) {
          this.db.insertArchive(plan.chunkStart, plan.chunkEnd, plan.newFile);
        }
        for (const id of plan.obsoleteIds) this.db.markArchiveObsolete(id);
      }
      for (const id of expiredArchiveIds) this.db.markArchiveObsolete(id);
      this.db.deleteHotBefore(hotStart);
      this.db.deleteColdDeltaBefore(hotStart);
      this.db.setCurrentHour(newHour);
      this.hooks.onMaintainBeforeCommit?.();
    });
    this.hooks.onMaintainAfterCommit?.();

    // Post-commit cleanup: remove obsolete archive files, then their registry rows.
    const obsoleteFiles = this.db.listArchives('obsolete');
    for (const row of obsoleteFiles) {
      removeFileIfExists(path.join(this.archivesDir, row.file));
      this.hooks.onMaintainDuringCleanup?.();
      this.db.transaction(() => this.db.deleteArchiveRow(row.id));
    }
  }

  /** Statistics for one resource over [fromHour, toHour), clipped to the retained range. */
  query(resource: string, fromHour: number, toHour: number): HourlyStats {
    const hour = this.currentHour;
    const retainStart = hour - RETENTION_HOURS;
    const hotStart = hour - HOT_HOURS;
    const from = Math.max(fromHour, retainStart);
    const to = Math.min(toHour, hour);
    if (from >= to) return { hours: 0, totalCpu: 0, maxCpu: 0 };

    const lists: MetricRecord[][] = [];
    const coldTo = Math.min(to, hotStart);
    if (from < coldTo) {
      for (const arch of this.db.activeArchivesOverlapping(from, coldTo)) {
        lists.push(
          readArchiveFile(path.join(this.archivesDir, arch.file)).filter(
            (r) => r.resource === resource && r.hour >= from && r.hour < coldTo,
          ),
        );
      }
      lists.push(this.db.selectColdDelta(resource, from, coldTo));
    }
    const hotFrom = Math.max(from, hotStart);
    if (hotFrom < to) {
      lists.push(this.db.selectHot(resource, hotFrom, to));
    }

    const effective = mergeByRevision(lists);
    let totalCpu = 0;
    let maxCpu = 0;
    for (const rec of effective) {
      totalCpu += rec.cpu;
      if (rec.cpu > maxCpu) maxCpu = rec.cpu;
    }
    return { hours: effective.length, totalCpu, maxCpu };
  }

  /** Names of active cold archive files (inspection/testing aid). */
  listArchiveFiles(): string[] {
    return this.db
      .listArchives('active')
      .map((a) => a.file)
      .sort();
  }

  close(): void {
    this.db.close();
  }
}
