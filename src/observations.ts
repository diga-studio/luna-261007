import type { DatabaseSync } from 'node:sqlite';
import { TimelineResolver } from './timeline.js';
import { SEVERITY_RANK, type IngestResult, type Observation } from './types.js';

/**
 * Ingest a batch of observations, deduplicating by stable ID. Both endpoints
 * are attributed by the ownership timeline at each observation's own time.
 * Edge aggregates are merged incrementally (count +1, max time, max severity),
 * which is exact for append-only inserts.
 */
export function ingestObservations(
  db: DatabaseSync,
  observations: readonly Observation[],
): IngestResult {
  const resolver = new TimelineResolver(db);
  const insert = db.prepare(
    `INSERT OR IGNORE INTO observations
       (id, src_ip, dst_ip, observed_at_ms, severity_rank, src_asset_id, dst_asset_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const mergeEdge = db.prepare(
    `INSERT INTO edges (src_asset_id, dst_asset_id, support_count, last_observed_at_ms, severity_rank)
     VALUES (?, ?, 1, ?, ?)
     ON CONFLICT (src_asset_id, dst_asset_id) DO UPDATE SET
       support_count = support_count + 1,
       last_observed_at_ms = MAX(last_observed_at_ms, excluded.last_observed_at_ms),
       severity_rank = MAX(severity_rank, excluded.severity_rank)`,
  );
  let inserted = 0;
  let duplicates = 0;
  db.exec('BEGIN');
  try {
    for (const obs of observations) {
      const rank = SEVERITY_RANK[obs.severity];
      if (rank === undefined) {
        throw new Error(`unknown severity: ${obs.severity}`);
      }
      const srcAsset = resolver.resolve(obs.srcIp, obs.observedAtMs);
      const dstAsset = resolver.resolve(obs.dstIp, obs.observedAtMs);
      const result = insert.run(
        obs.id,
        obs.srcIp,
        obs.dstIp,
        obs.observedAtMs,
        rank,
        srcAsset,
        dstAsset,
      );
      if (Number(result.changes) === 0) {
        duplicates += 1;
        continue;
      }
      inserted += 1;
      if (srcAsset !== null && dstAsset !== null && srcAsset !== dstAsset) {
        mergeEdge.run(srcAsset, dstAsset, obs.observedAtMs, rank);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { inserted, duplicates };
}
