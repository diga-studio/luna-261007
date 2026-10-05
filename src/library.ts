import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from './db.js';
import { ImageStore } from './images.js';
import { computeMatchRate, decodePng } from './png.js';
import {
  RunNotFoundError,
  VersionConflictError,
  type ImageComparison,
  type LibraryOptions,
  type RunImageData,
  type RunInfo,
  type ScreenshotInput,
} from './types.js';

export const MATCH_THRESHOLD = 98;

interface RunRow {
  id: number;
  status: 'processing' | 'completed';
  passed: number | null;
  baseline_version: number;
}

interface RunImageRow {
  name: string;
  image_id: string;
  baseline_image_id: string | null;
  match_rate: number | null;
  passed: number | null;
}

/**
 * Visual regression baseline library for a single test group.
 * Metadata lives in SQLite, PNG files in a local directory.
 *
 * Background work (comparison, retention cleanup, image GC) runs on a serial
 * in-process queue; waitForIdle() drains it. All database mutations happen in
 * synchronous transactions, so a failed approval leaves nothing half-applied.
 */
export class VisualRegressionBaseline {
  private readonly db: DatabaseSync;
  private readonly images: ImageStore;
  private readonly maxRetainedRuns: number;
  private queue: Promise<void> = Promise.resolve();
  private backgroundError: unknown = null;

  constructor(options: LibraryOptions) {
    if (!Number.isInteger(options.maxRetainedRuns) || options.maxRetainedRuns < 1) {
      throw new Error('maxRetainedRuns must be a positive integer');
    }
    this.maxRetainedRuns = options.maxRetainedRuns;
    fs.mkdirSync(options.dir, { recursive: true });
    this.db = openDatabase(path.join(options.dir, 'metadata.db'));
    this.images = new ImageStore(this.db, path.join(options.dir, 'images'));
  }

  /** Current published baseline version (starts at 0, empty content). */
  getBaselineVersion(): number {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = 'baseline_version'`).get() as {
      value: string;
    };
    return Number(row.value);
  }

  /**
   * Submit a run of named screenshots. Pins the currently published baseline
   * set; comparison runs in the background and is immune to later approvals.
   */
  submitRun(screenshots: ScreenshotInput[]): number {
    if (screenshots.length === 0) {
      throw new Error('a run must contain at least one screenshot');
    }
    const names = new Set<string>();
    for (const shot of screenshots) {
      if (names.has(shot.name)) {
        throw new Error(`duplicate screenshot name: ${shot.name}`);
      }
      names.add(shot.name);
    }
    const baselineVersion = this.getBaselineVersion();
    const baselineRows = this.db.prepare(`SELECT name, image_id FROM baseline`).all() as Array<{
      name: string;
      image_id: string;
    }>;
    const pinned = new Map(baselineRows.map((row) => [row.name, row.image_id]));

    this.db.exec('BEGIN IMMEDIATE');
    let runId: number;
    try {
      const stored = screenshots.map((shot) => ({ name: shot.name, id: this.images.put(shot.png) }));
      runId = Number(
        this.db
          .prepare(`INSERT INTO runs (status, passed, baseline_version) VALUES ('processing', NULL, ?)`)
          .run(baselineVersion).lastInsertRowid,
      );
      const insertImage = this.db.prepare(
        `INSERT INTO run_images (run_id, name, image_id, baseline_image_id) VALUES (?, ?, ?, ?)`,
      );
      for (const { name, id } of stored) {
        insertImage.run(runId, name, id, pinned.get(name) ?? null);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.enqueue(async () => {
      this.compareRun(runId);
      this.enforceRetention();
      this.images.collectGarbage();
    });
    return runId;
  }

  /** Query a run: either processing state or the complete, immutable result. */
  getRun(runId: number): RunInfo {
    const run = this.getRunRow(runId);
    if (run.status === 'processing') {
      return { runId, status: 'processing' };
    }
    const images = this.getRunImageRows(runId).map<ImageComparison>((row) => ({
      name: row.name,
      matchRate: row.match_rate,
      passed: row.passed === 1,
    }));
    return {
      runId,
      status: 'completed',
      passed: run.passed === 1,
      baselineVersion: run.baseline_version,
      images,
    };
  }

  /** Fetch this run's screenshots and the baseline images actually used. */
  getRunImages(runId: number): RunImageData[] {
    this.getRunRow(runId);
    return this.getRunImageRows(runId).map((row) => ({
      name: row.name,
      screenshot: this.images.get(row.image_id),
      baseline: row.baseline_image_id === null ? null : this.images.get(row.baseline_image_id),
    }));
  }

  /**
   * Publish selected screenshots of a completed, retained run as the new
   * baseline. All-or-nothing; fails on version conflict without retrying.
   * Returns the new baseline version.
   */
  approve(runId: number, names: string[], expectedVersion: number): number {
    if (names.length === 0) {
      throw new Error('approve requires at least one screenshot name');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const actualVersion = this.getBaselineVersion();
      if (actualVersion !== expectedVersion) {
        throw new VersionConflictError(expectedVersion, actualVersion);
      }
      const run = this.getRunRow(runId);
      if (run.status !== 'completed') {
        throw new Error(`run ${runId} has not completed`);
      }
      const rows = this.getRunImageRows(runId);
      const byName = new Map(rows.map((row) => [row.name, row.image_id]));
      const publish = this.db.prepare(
        `INSERT INTO baseline (name, image_id) VALUES (?, ?)
         ON CONFLICT (name) DO UPDATE SET image_id = excluded.image_id`,
      );
      for (const name of names) {
        const imageId = byName.get(name);
        if (imageId === undefined) {
          throw new Error(`run ${runId} has no screenshot named ${name}`);
        }
        publish.run(name, imageId);
      }
      const newVersion = actualVersion + 1;
      this.db
        .prepare(`UPDATE meta SET value = ? WHERE key = 'baseline_version'`)
        .run(String(newVersion));
      this.db.exec('COMMIT');
      this.enqueue(async () => {
        this.images.collectGarbage();
      });
      return newVersion;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Wait for background comparison, retention cleanup and image GC to finish. */
  async waitForIdle(): Promise<void> {
    let pending: Promise<void>;
    do {
      pending = this.queue;
      await pending;
    } while (pending !== this.queue);
    if (this.backgroundError !== null) {
      const error = this.backgroundError;
      this.backgroundError = null;
      throw error;
    }
  }

  /** Release resources. */
  close(): void {
    this.db.close();
  }

  private getRunRow(runId: number): RunRow {
    const row = this.db
      .prepare(`SELECT id, status, passed, baseline_version FROM runs WHERE id = ?`)
      .get(runId) as RunRow | undefined;
    if (!row) {
      throw new RunNotFoundError(runId);
    }
    return row;
  }

  private getRunImageRows(runId: number): RunImageRow[] {
    return this.db
      .prepare(
        `SELECT name, image_id, baseline_image_id, match_rate, passed
         FROM run_images WHERE run_id = ? ORDER BY name`,
      )
      .all(runId) as unknown as RunImageRow[];
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch((error: unknown) => {
      this.backgroundError ??= error;
    });
  }

  /** Compare one run against its pinned baseline and store the complete result. */
  private compareRun(runId: number): void {
    const rows = this.getRunImageRows(runId);
    const outcomes = rows.map((row) => {
      if (row.baseline_image_id === null) {
        return { name: row.name, matchRate: null as number | null, passed: false };
      }
      const matchRate = computeMatchRate(
        decodePng(this.images.get(row.image_id)),
        decodePng(this.images.get(row.baseline_image_id)),
      );
      return { name: row.name, matchRate, passed: matchRate >= MATCH_THRESHOLD };
    });
    const runPassed = outcomes.every((outcome) => outcome.passed);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const update = this.db.prepare(
        `UPDATE run_images SET match_rate = ?, passed = ? WHERE run_id = ? AND name = ?`,
      );
      for (const outcome of outcomes) {
        update.run(outcome.matchRate, outcome.passed ? 1 : 0, runId, outcome.name);
      }
      this.db
        .prepare(`UPDATE runs SET status = 'completed', passed = ? WHERE id = ?`)
        .run(runPassed ? 1 : 0, runId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Delete the oldest completed runs beyond the retention limit. */
  private enforceRetention(): void {
    const excess = this.db
      .prepare(
        `SELECT id FROM runs WHERE status = 'completed' ORDER BY id DESC LIMIT -1 OFFSET ?`,
      )
      .all(this.maxRetainedRuns) as Array<{ id: number }>;
    if (excess.length === 0) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const deleteImages = this.db.prepare(`DELETE FROM run_images WHERE run_id = ?`);
      const deleteRun = this.db.prepare(`DELETE FROM runs WHERE id = ?`);
      for (const { id } of excess) {
        deleteImages.run(id);
        deleteRun.run(id);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
