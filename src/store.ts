import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from './db.js';
import { getDependency, getGraph } from './dependencies.js';
import { ingestObservations } from './observations.js';
import { reviseOwnership } from './revision.js';
import type {
  Dependency,
  IngestResult,
  Observation,
  OwnershipInterval,
  RevisionResult,
} from './types.js';

/**
 * Facade used directly by callers. All calls are executed serially; each
 * method is self-consistent before returning.
 */
export class DependencyStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = openDatabase(dbPath);
  }

  /** Register or revise the full ownership timeline of one IP. */
  reviseOwnership(ip: string, intervals: readonly OwnershipInterval[]): RevisionResult {
    return reviseOwnership(this.db, ip, intervals);
  }

  /** Batch-ingest connection observations (out-of-order, late, duplicates). */
  ingest(observations: readonly Observation[]): IngestResult {
    return ingestObservations(this.db, observations);
  }

  /** Read the dependency of one directed asset pair; null when absent. */
  getDependency(srcAssetId: string, dstAssetId: string, nowMs: number): Dependency | null {
    return getDependency(this.db, srcAssetId, dstAssetId, nowMs);
  }

  /** Read the complete dependency graph. */
  getGraph(nowMs: number): Dependency[] {
    return getGraph(this.db, nowMs);
  }

  close(): void {
    this.db.close();
  }
}
