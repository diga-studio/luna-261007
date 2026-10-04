import { DatabaseSync, StatementSync } from 'node:sqlite';
import { openDatabase } from './db.js';
import { lookupOwner, validateTimeline } from './timeline.js';
import {
  RANK_SEVERITY,
  SEVERITY_RANK,
  STALE_THRESHOLD_MS,
  type Dependency,
  type IngestResult,
  type Observation,
  type OwnershipInterval,
  type Severity,
} from './types.js';

interface ObservationRow {
  id: string;
  src_ip: string;
  dst_ip: string;
  ts: number;
  severity: string;
  src_asset: string | null;
  dst_asset: string | null;
}

interface EdgeRow {
  src_asset: string;
  dst_asset: string;
  cnt: number;
  last_ts: number;
  sev_rank: number;
}

const SEV_CASE = `CASE severity WHEN 'critical' THEN 2 WHEN 'standard' THEN 1 ELSE 0 END`;

/**
 * Network dependency attribution store.
 *
 * Calls are executed serially; no internal locking is provided.
 * All timestamps are UTC milliseconds.
 */
export class AttributionStore {
  private readonly db: DatabaseSync;
  private readonly timelineCache = new Map<string, OwnershipInterval[]>();

  private readonly stmtInsertObservation: StatementSync;
  private readonly stmtUpdateObservationAssets: StatementSync;
  private readonly stmtObservationsByIp: StatementSync;
  private readonly stmtLoadTimeline: StatementSync;
  private readonly stmtDeleteTimeline: StatementSync;
  private readonly stmtInsertInterval: StatementSync;
  private readonly stmtUpsertEdgeIncrement: StatementSync;
  private readonly stmtAggregateEdge: StatementSync;
  private readonly stmtDeleteEdge: StatementSync;
  private readonly stmtReplaceEdge: StatementSync;
  private readonly stmtGetEdge: StatementSync;
  private readonly stmtAllEdges: StatementSync;

  constructor(path: string) {
    this.db = openDatabase(path);
    this.stmtInsertObservation = this.db.prepare(
      `INSERT INTO observations (id, src_ip, dst_ip, ts, severity, src_asset, dst_asset)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    );
    this.stmtUpdateObservationAssets = this.db.prepare(
      `UPDATE observations SET src_asset = ?, dst_asset = ? WHERE id = ?`,
    );
    this.stmtObservationsByIp = this.db.prepare(
      `SELECT id, src_ip, dst_ip, ts, severity, src_asset, dst_asset
       FROM observations WHERE src_ip = ? OR dst_ip = ?`,
    );
    this.stmtLoadTimeline = this.db.prepare(
      `SELECT start_ms, end_ms, asset_id FROM timelines WHERE ip = ? ORDER BY start_ms`,
    );
    this.stmtDeleteTimeline = this.db.prepare(`DELETE FROM timelines WHERE ip = ?`);
    this.stmtInsertInterval = this.db.prepare(
      `INSERT INTO timelines (ip, start_ms, end_ms, asset_id) VALUES (?, ?, ?, ?)`,
    );
    this.stmtUpsertEdgeIncrement = this.db.prepare(
      `INSERT INTO edges (src_asset, dst_asset, cnt, last_ts, sev_rank)
       VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(src_asset, dst_asset) DO UPDATE SET
         cnt = cnt + 1,
         last_ts = MAX(last_ts, excluded.last_ts),
         sev_rank = MAX(sev_rank, excluded.sev_rank)`,
    );
    this.stmtAggregateEdge = this.db.prepare(
      `SELECT COUNT(*) AS cnt, MAX(ts) AS last_ts, MAX(${SEV_CASE}) AS sev_rank
       FROM observations WHERE src_asset = ? AND dst_asset = ?`,
    );
    this.stmtDeleteEdge = this.db.prepare(
      `DELETE FROM edges WHERE src_asset = ? AND dst_asset = ?`,
    );
    this.stmtReplaceEdge = this.db.prepare(
      `INSERT INTO edges (src_asset, dst_asset, cnt, last_ts, sev_rank)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(src_asset, dst_asset) DO UPDATE SET
         cnt = excluded.cnt, last_ts = excluded.last_ts, sev_rank = excluded.sev_rank`,
    );
    this.stmtGetEdge = this.db.prepare(
      `SELECT src_asset, dst_asset, cnt, last_ts, sev_rank
       FROM edges WHERE src_asset = ? AND dst_asset = ?`,
    );
    this.stmtAllEdges = this.db.prepare(
      `SELECT src_asset, dst_asset, cnt, last_ts, sev_rank FROM edges`,
    );
  }

  /** Replace the complete ownership timeline of one IP. */
  reviseTimeline(ip: string, intervals: OwnershipInterval[]): void {
    const sorted = validateTimeline(intervals);
    this.inTransaction(() => {
      this.stmtDeleteTimeline.run(ip);
      for (const iv of sorted) {
        this.stmtInsertInterval.run(ip, iv.startMs, iv.endMs, iv.assetId);
      }
      this.timelineCache.set(ip, sorted);

      const affected = this.stmtObservationsByIp.all(ip, ip) as unknown as ObservationRow[];
      const touchedEdges = new Set<string>();
      const touchedPairs: Array<[string, string]> = [];
      const markEdge = (src: string | null, dst: string | null) => {
        if (src === null || dst === null || src === dst) return;
        const key = `${src}→${dst}`;
        if (!touchedEdges.has(key)) {
          touchedEdges.add(key);
          touchedPairs.push([src, dst]);
        }
      };

      for (const row of affected) {
        const newSrc = row.src_ip === ip ? this.resolveOwner(ip, row.ts) : row.src_asset;
        const newDst = row.dst_ip === ip ? this.resolveOwner(ip, row.ts) : row.dst_asset;
        if (newSrc === row.src_asset && newDst === row.dst_asset) continue;
        markEdge(row.src_asset, row.dst_asset);
        markEdge(newSrc, newDst);
        this.stmtUpdateObservationAssets.run(newSrc, newDst, row.id);
      }

      for (const [src, dst] of touchedPairs) {
        this.recomputeEdge(src, dst);
      }
    });
  }

  /** Ingest a batch of observations (any order, duplicates ignored). */
  ingest(observations: Observation[]): IngestResult {
    let accepted = 0;
    this.inTransaction(() => {
      for (const obs of observations) {
        this.validateObservation(obs);
        const srcAsset = this.resolveOwner(obs.srcIp, obs.observedAtMs);
        const dstAsset = this.resolveOwner(obs.dstIp, obs.observedAtMs);
        const res = this.stmtInsertObservation.run(
          obs.id,
          obs.srcIp,
          obs.dstIp,
          obs.observedAtMs,
          obs.severity,
          srcAsset,
          dstAsset,
        );
        if (Number(res.changes) === 0) continue;
        accepted += 1;
        if (srcAsset !== null && dstAsset !== null && srcAsset !== dstAsset) {
          this.stmtUpsertEdgeIncrement.run(
            srcAsset,
            dstAsset,
            obs.observedAtMs,
            SEVERITY_RANK[obs.severity],
          );
        }
      }
    });
    return { received: observations.length, accepted, duplicates: observations.length - accepted };
  }

  /** Read the dependency for one directed asset pair, or null if none. */
  getDependency(srcAsset: string, dstAsset: string, nowMs: number): Dependency | null {
    const row = this.stmtGetEdge.get(srcAsset, dstAsset) as unknown as EdgeRow | undefined;
    if (!row) return null;
    return toDependency(row, nowMs);
  }

  /** Read the full dependency graph. */
  getGraph(nowMs: number): Dependency[] {
    const rows = this.stmtAllEdges.all() as unknown as EdgeRow[];
    return rows.map((row) => toDependency(row, nowMs));
  }

  close(): void {
    this.db.close();
  }

  private resolveOwner(ip: string, atMs: number): string | null {
    let timeline = this.timelineCache.get(ip);
    if (timeline === undefined) {
      const rows = this.stmtLoadTimeline.all(ip) as unknown as Array<{
        start_ms: number;
        end_ms: number | null;
        asset_id: string;
      }>;
      timeline = rows.map((r) => ({ startMs: r.start_ms, endMs: r.end_ms, assetId: r.asset_id }));
      this.timelineCache.set(ip, timeline);
    }
    return lookupOwner(timeline, atMs);
  }

  private recomputeEdge(srcAsset: string, dstAsset: string): void {
    const row = this.stmtAggregateEdge.get(srcAsset, dstAsset) as unknown as {
      cnt: number;
      last_ts: number | null;
      sev_rank: number | null;
    };
    if (row.cnt === 0 || row.last_ts === null || row.sev_rank === null) {
      this.stmtDeleteEdge.run(srcAsset, dstAsset);
    } else {
      this.stmtReplaceEdge.run(srcAsset, dstAsset, row.cnt, row.last_ts, row.sev_rank);
    }
  }

  private validateObservation(obs: Observation): void {
    if (typeof obs.id !== 'string' || obs.id.length === 0) {
      throw new Error('observation id must be a non-empty string');
    }
    if (!Number.isFinite(obs.observedAtMs) || obs.observedAtMs < 0) {
      throw new Error(`invalid observedAtMs: ${obs.observedAtMs}`);
    }
    if (!(obs.severity in SEVERITY_RANK)) {
      throw new Error(`invalid severity: ${obs.severity}`);
    }
  }

  private inTransaction(fn: () => void): void {
    this.db.exec('BEGIN');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}

function toDependency(row: EdgeRow, nowMs: number): Dependency {
  return {
    srcAsset: row.src_asset,
    dstAsset: row.dst_asset,
    supportCount: row.cnt,
    lastObservedAtMs: row.last_ts,
    severity: RANK_SEVERITY[row.sev_rank] as Severity,
    stale: nowMs - row.last_ts >= STALE_THRESHOLD_MS,
  };
}
