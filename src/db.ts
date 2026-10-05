import { ImageComparison } from './types';
import { DatabaseSync } from 'node:sqlite';

export interface StoredImageRef {
  name: string;
  imageId: string;
}

export interface RunRow {
  id: string;
  seq: number;
  status: 'processing' | 'completed';
  baselineVersion: number;
  result: { passed: boolean; images: ImageComparison[] } | null;
}

/** SQLite-backed metadata store. All multi-row writes happen in transactions. */
export class MetadataStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS images (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS baseline (
        name TEXT PRIMARY KEY,
        image_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL UNIQUE,
        status TEXT NOT NULL,
        baseline_version INTEGER NOT NULL,
        result TEXT
      );
      CREATE TABLE IF NOT EXISTS run_images (
        run_id TEXT NOT NULL,
        name TEXT NOT NULL,
        image_id TEXT NOT NULL,
        PRIMARY KEY (run_id, name)
      );
      CREATE TABLE IF NOT EXISTS run_baselines (
        run_id TEXT NOT NULL,
        name TEXT NOT NULL,
        image_id TEXT NOT NULL,
        PRIMARY KEY (run_id, name)
      );
    `);
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = 'baseline_version'`).get();
    if (!row) {
      this.db.prepare(`INSERT INTO meta (key, value) VALUES ('baseline_version', '0')`).run();
    }
  }

  private nextSeq(): number {
    const row = this.db.prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM runs`).get();
    return Number(row!.seq);
  }

  registerImage(id: string, path: string): void {
    this.db.prepare(`INSERT OR IGNORE INTO images (id, path) VALUES (?, ?)`).run(id, path);
  }

  getBaselineVersion(): number {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = 'baseline_version'`).get();
    return Number(row!.value);
  }
  /** name -> imageId for the currently published baseline. */
  getBaselineEntries(): Map<string, string> {
    const rows = this.db.prepare(`SELECT name, image_id FROM baseline`).all();
    const map = new Map<string, string>();
    for (const row of rows) map.set(String(row.name), String(row.image_id));
    return map;
  }

  /** Insert a processing run with its screenshots and pinned baseline snapshot. */
  insertRun(runId: string, screenshots: StoredImageRef[], pinnedBaseline: StoredImageRef[], baselineVersion: number): void {
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(`INSERT INTO runs (id, seq, status, baseline_version, result) VALUES (?, ?, 'processing', ?, NULL)`)
        .run(runId, this.nextSeq(), baselineVersion);
      const img = this.db.prepare(`INSERT INTO run_images (run_id, name, image_id) VALUES (?, ?, ?)`);
      for (const s of screenshots) img.run(runId, s.name, s.imageId);
      const base = this.db.prepare(`INSERT INTO run_baselines (run_id, name, image_id) VALUES (?, ?, ?)`);
      for (const b of pinnedBaseline) base.run(runId, b.name, b.imageId);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getRun(runId: string): RunRow | null {
    const row = this.db
      .prepare(`SELECT id, seq, status, baseline_version, result FROM runs WHERE id = ?`)
      .get(runId);
    if (!row) return null;
    return {
      id: String(row.id),
      seq: Number(row.seq),
      status: row.status as RunRow['status'],
      baselineVersion: Number(row.baseline_version),
      result: row.result == null ? null : (JSON.parse(String(row.result)) as RunRow['result']),
    };
  }
  getRunImages(runId: string): StoredImageRef[] {
    return this.db
      .prepare(`SELECT name, image_id FROM run_images WHERE run_id = ? ORDER BY name`)
      .all(runId)
      .map((r) => ({ name: String(r.name), imageId: String(r.image_id) }));
  }
  getRunBaselineImages(runId: string): StoredImageRef[] {
    return this.db
      .prepare(`SELECT name, image_id FROM run_baselines WHERE run_id = ? ORDER BY name`)
      .all(runId)
      .map((r) => ({ name: String(r.name), imageId: String(r.image_id) }));
  }
  completeRun(runId: string, passed: boolean, images: ImageComparison[]): void {
    this.db
      .prepare(`UPDATE runs SET status = 'completed', result = ? WHERE id = ?`)
      .run(JSON.stringify({ passed, images }), runId);
  }

  /**
   * Atomically publish `entries` as baseline replacements iff the current
   * version equals `expectedVersion`. Returns the new version, or null on
   * version conflict.
   */
  publishBaseline(entries: StoredImageRef[], expectedVersion: number): number | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.getBaselineVersion();
      if (current !== expectedVersion) {
        this.db.exec('ROLLBACK');
        return null;
      }
      const next = current + 1;
      const upsert = this.db.prepare(
        `INSERT INTO baseline (name, image_id) VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET image_id = excluded.image_id`,
      );
      for (const e of entries) upsert.run(e.name, e.imageId);
      this.db.prepare(`UPDATE meta SET value = ? WHERE key = 'baseline_version'`).run(String(next));
      this.db.exec('COMMIT');
      return next;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Delete oldest completed runs beyond `limit`; returns deleted run ids. */
  pruneCompletedRuns(limit: number): string[] {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.db
        .prepare(`SELECT id FROM runs WHERE status = 'completed' ORDER BY seq ASC`)
        .all();
      const excess = rows.length - limit;
      const deleted: string[] = [];
      if (excess > 0) {
        const delRun = this.db.prepare(`DELETE FROM runs WHERE id = ?`);
        const delImages = this.db.prepare(`DELETE FROM run_images WHERE run_id = ?`);
        const delBaselines = this.db.prepare(`DELETE FROM run_baselines WHERE run_id = ?`);
        for (const row of rows.slice(0, excess)) {
          const id = String(row.id);
          delImages.run(id);
          delBaselines.run(id);
          delRun.run(id);
          deleted.push(id);
        }
      }
      this.db.exec('COMMIT');
      return deleted;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Image ids referenced by the baseline, unfinished runs and retained runs. */
  listReferencedImageIds(): Set<string> {
    const refs = new Set<string>();
    for (const row of this.db.prepare(`SELECT image_id FROM baseline`).all()) {
      refs.add(String(row.image_id));
    }
    for (const row of this.db.prepare(`SELECT image_id FROM run_images`).all()) {
      refs.add(String(row.image_id));
    }
    for (const row of this.db.prepare(`SELECT image_id FROM run_baselines`).all()) {
      refs.add(String(row.image_id));
    }
    return refs;
  }
  listAllImages(): Array<{ id: string; path: string }> {
    return this.db
      .prepare(`SELECT id, path FROM images`)
      .all()
      .map((r) => ({ id: String(r.id), path: String(r.path) }));
  }
  deleteImages(ids: string[]): void {
    if (ids.length === 0) return;
    const del = this.db.prepare(`DELETE FROM images WHERE id = ?`);
    for (const id of ids) del.run(id);
  }

  close(): void {
    this.db.close();
  }
}
