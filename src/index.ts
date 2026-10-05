import { collectEvidence, tripleKey } from "./evidence.js";
import { findOptimalKeep } from "./optimize.js";
import type { Advice, Snapshot } from "./types.js";

export type { Triple, Grant, AccessEvent, Snapshot, Advice } from "./types.js";
export { WINDOW_MS } from "./evidence.js";

/**
 * 基于快照给出最小权限建议：返回保留与撤销清单。
 * 仅在进程内存中计算，不做任何持久化或网络访问。
 */
export function advise(snapshot: Snapshot): Advice {
  const { now, grants, events } = snapshot;

  const seenIds = new Set<number>();
  for (const grant of grants) {
    if (!Number.isInteger(grant.id) || grant.id <= 0) {
      throw new Error(`授权编号必须为正整数，收到: ${grant.id}`);
    }
    if (seenIds.has(grant.id)) {
      throw new Error(`授权编号重复: ${grant.id}`);
    }
    seenIds.add(grant.id);
  }

  const evidence = collectEvidence(events, now);

  // 与证据无交集的授权保留只会增加暴露与数量，直接撤销。
  const candidateIds: number[] = [];
  const candidateCoverage: Set<string>[] = [];
  const coverageById = new Map<number, Set<string>>();
  for (const grant of grants) {
    const keys = new Set(grant.coverage.map(tripleKey));
    coverageById.set(grant.id, keys);
    let touchesEvidence = false;
    for (const key of keys) {
      if (evidence.has(key)) {
        touchesEvidence = true;
        break;
      }
    }
    if (touchesEvidence) {
      candidateIds.push(grant.id);
      candidateCoverage.push(keys);
    }
  }

  const keepSet = new Set(findOptimalKeep(candidateIds, candidateCoverage, evidence));

  const keep: number[] = [];
  const revoke: number[] = [];
  for (const grant of grants) {
    if (keepSet.has(grant.id)) keep.push(grant.id);
    else revoke.push(grant.id);
  }
  keep.sort((a, b) => a - b);
  revoke.sort((a, b) => a - b);
  return { keep, revoke };
}
