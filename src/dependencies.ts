import type { DatabaseSync } from 'node:sqlite';
import { STALE_THRESHOLD_MS, type Dependency, type Severity } from './types.js';

const RANK_TO_SEVERITY: Record<number, Severity> = {
  1: 'informational',
  2: 'standard',
  3: 'critical',
};

export function edgeKey(srcAssetId: string, dstAssetId: string): string {
  return JSON.stringify([srcAssetId, dstAssetId]);
}

export function parseEdgeKey(key: string): [string, string] {
  return JSON.parse(key) as [string, string];
}

/**
 * Recompute the materialized edge rows for the given directed pairs from the
 * observations table. Pairs with no supporting observations are removed.
 * Returns the number of pairs examined.
 */
export function refreshEdges(
  db: DatabaseSync,
  pairs: ReadonlySet<string>,
): number {
  if (pairs.size === 0) {
    return 0;
  }
  const aggregate = db.prepare(
    `SELECT COUNT(*) AS cnt, MAX(observed_at_ms) AS lastMs, MAX(severity_rank) AS sev
     FROM observations
     WHERE src_asset_id = ? AND dst_asset_id = ? AND src_asset_id != dst_asset_id`,
  );
  const upsert = db.prepare(
    `INSERT INTO edges (src_asset_id, dst_asset_id, support_count, last_observed_at_ms, severity_rank)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (src_asset_id, dst_asset_id) DO UPDATE SET
       support_count = excluded.support_count,
       last_observed_at_ms = excluded.last_observed_at_ms,
       severity_rank = excluded.severity_rank`,
  );
  const remove = db.prepare(
    'DELETE FROM edges WHERE src_asset_id = ? AND dst_asset_id = ?',
  );
  db.exec('BEGIN');
  try {
    for (const pair of pairs) {
      const [src, dst] = parseEdgeKey(pair);
      const row = aggregate.get(src, dst) as {
        cnt: number;
        lastMs: number | null;
        sev: number | null;
      };
      if (row.cnt === 0 || row.lastMs === null || row.sev === null) {
        remove.run(src, dst);
      } else {
        upsert.run(src, dst, row.cnt, row.lastMs, row.sev);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return pairs.size;
}

interface EdgeRow {
  srcAssetId: string;
  dstAssetId: string;
  supportCount: number;
  lastObservedAtMs: number;
  severityRank: number;
}

function toDependency(row: EdgeRow, nowMs: number): Dependency {
  const severity = RANK_TO_SEVERITY[row.severityRank];
  if (severity === undefined) {
    throw new Error(`corrupt severity rank ${row.severityRank}`);
  }
  return {
    srcAssetId: row.srcAssetId,
    dstAssetId: row.dstAssetId,
    supportCount: row.supportCount,
    lastObservedAtMs: row.lastObservedAtMs,
    severity,
    stale: nowMs - row.lastObservedAtMs >= STALE_THRESHOLD_MS,
  };
}

const SELECT_EDGE = `
  SELECT src_asset_id AS srcAssetId, dst_asset_id AS dstAssetId,
         support_count AS supportCount, last_observed_at_ms AS lastObservedAtMs,
         severity_rank AS severityRank
  FROM edges
`;

/** Read the dependency for one directed asset pair; null when absent. */
export function getDependency(
  db: DatabaseSync,
  srcAssetId: string,
  dstAssetId: string,
  nowMs: number,
): Dependency | null {
  const row = db
    .prepare(`${SELECT_EDGE} WHERE src_asset_id = ? AND dst_asset_id = ?`)
    .get(srcAssetId, dstAssetId) as EdgeRow | undefined;
  return row === undefined ? null : toDependency(row, nowMs);
}

/** Read the full dependency graph. */
export function getGraph(db: DatabaseSync, nowMs: number): Dependency[] {
  const rows = db
    .prepare(`${SELECT_EDGE} ORDER BY src_asset_id, dst_asset_id`)
    .all() as EdgeRow[];
  return rows.map((row) => toDependency(row, nowMs));
}
