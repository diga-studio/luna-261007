import type { DatabaseSync } from 'node:sqlite';
import { edgeKey, refreshEdges } from './dependencies.js';
import { TimelineResolver, replaceTimeline } from './timeline.js';
import type { OwnershipInterval, RevisionResult } from './types.js';

interface CandidateRow {
  id: string;
  srcIp: string;
  dstIp: string;
  observedAtMs: number;
  srcAssetId: string | null;
  dstAssetId: string | null;
}

/**
 * Replace the full ownership timeline of `ip` and re-attribute every stored
 * observation that mentions it. Dependency edges touched by the migration
 * (old and new pairs) are recomputed from the observations table, so edges
 * still supported by other observations are kept with accurate aggregates.
 */
export function reviseOwnership(
  db: DatabaseSync,
  ip: string,
  intervals: readonly OwnershipInterval[],
): RevisionResult {
  const candidates = db
    .prepare(
      `SELECT id, src_ip AS srcIp, dst_ip AS dstIp, observed_at_ms AS observedAtMs,
              src_asset_id AS srcAssetId, dst_asset_id AS dstAssetId
       FROM observations WHERE src_ip = ? OR dst_ip = ?`,
    )
    .all(ip, ip) as CandidateRow[];

  replaceTimeline(db, ip, intervals);

  const resolver = new TimelineResolver(db);
  const update = db.prepare(
    'UPDATE observations SET src_asset_id = ?, dst_asset_id = ? WHERE id = ?',
  );
  const affected = new Set<string>();
  let reattributed = 0;
  db.exec('BEGIN');
  try {
    for (const row of candidates) {
      const newSrc =
        row.srcIp === ip ? resolver.resolve(ip, row.observedAtMs) : row.srcAssetId;
      const newDst =
        row.dstIp === ip ? resolver.resolve(ip, row.observedAtMs) : row.dstAssetId;
      if (newSrc === row.srcAssetId && newDst === row.dstAssetId) {
        continue;
      }
      update.run(newSrc, newDst, row.id);
      reattributed += 1;
      if (row.srcAssetId !== null && row.dstAssetId !== null) {
        affected.add(edgeKey(row.srcAssetId, row.dstAssetId));
      }
      if (newSrc !== null && newDst !== null) {
        affected.add(edgeKey(newSrc, newDst));
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  const affectedEdges = refreshEdges(db, affected);
  return { reattributed, affectedEdges };
}
