import { maxMatchingSize } from "./matching.js";
import type { AnalysisResult, Pair, ResolveResult, Session } from "./types.js";

function pairKey(pair: Pair): string {
  return JSON.stringify([pair.transactionId, pair.journalId]);
}

function samePair(a: Pair, b: Pair): boolean {
  return a.transactionId === b.transactionId && a.journalId === b.journalId;
}

/**
 * Size of the maximum matching that contains every forced pair.
 * Assumes forced pairs are candidate edges with pairwise disjoint endpoints.
 * Optionally excludes one candidate edge (by index) or one vertex.
 */
function matchingSizeWithForced(
  session: Session,
  forced: readonly Pair[],
  excludeEdgeIndex = -1,
  excludeVertex?: string
): number {
  const usedTransactions = new Set(forced.map((p) => p.transactionId));
  const usedJournals = new Set(forced.map((p) => p.journalId));
  const left = session.transactionIds.filter(
    (id) => !usedTransactions.has(id) && id !== excludeVertex
  );
  const right = session.journalIds.filter(
    (id) => !usedJournals.has(id) && id !== excludeVertex
  );
  const edges = session.candidatePairs
    .map((p, index) => ({ left: p.transactionId, right: p.journalId, index }))
    .filter(
      (e) =>
        e.index !== excludeEdgeIndex &&
        !usedTransactions.has(e.left) &&
        !usedJournals.has(e.right) &&
        e.left !== excludeVertex &&
        e.right !== excludeVertex
    );
  return forced.length + maxMatchingSize(left, right, edges);
}

function isCandidate(session: Session, pair: Pair): boolean {
  return session.candidatePairs.some((p) => samePair(p, pair));
}

function hasConflict(pairs: readonly Pair[]): boolean {
  const transactions = new Set<string>();
  const journals = new Set<string>();
  for (const pair of pairs) {
    if (transactions.has(pair.transactionId) || journals.has(pair.journalId)) {
      return true;
    }
    transactions.add(pair.transactionId);
    journals.add(pair.journalId);
  }
  return false;
}

export function create(
  transactionIds: readonly string[],
  journalIds: readonly string[],
  candidatePairs: readonly Pair[]
): Session {
  const transactionSet = new Set(transactionIds);
  if (transactionSet.size !== transactionIds.length) {
    throw new Error("duplicate transaction ids");
  }
  const journalSet = new Set(journalIds);
  if (journalSet.size !== journalIds.length) {
    throw new Error("duplicate journal ids");
  }
  const seen = new Set<string>();
  const pairs: Pair[] = [];
  for (const pair of candidatePairs) {
    if (!transactionSet.has(pair.transactionId)) {
      throw new Error(`unknown transaction id: ${pair.transactionId}`);
    }
    if (!journalSet.has(pair.journalId)) {
      throw new Error(`unknown journal id: ${pair.journalId}`);
    }
    const key = pairKey(pair);
    if (!seen.has(key)) {
      seen.add(key);
      pairs.push({ transactionId: pair.transactionId, journalId: pair.journalId });
    }
  }
  return Object.freeze({
    transactionIds: Object.freeze([...transactionIds]),
    journalIds: Object.freeze([...journalIds]),
    candidatePairs: Object.freeze(pairs),
    acceptedPairs: Object.freeze([]),
  });
}

export function analyze(session: Session): AnalysisResult {
  const accepted = session.acceptedPairs;
  const k = matchingSizeWithForced(session, accepted);

  const certainPairs: Pair[] = [];
  const possiblePairs: Pair[] = [];
  session.candidatePairs.forEach((pair, index) => {
    const isAccepted = accepted.some((p) => samePair(p, pair));
    if (isAccepted) {
      certainPairs.push(pair);
      possiblePairs.push(pair);
      return;
    }
    const conflicts = accepted.some(
      (p) =>
        p.transactionId === pair.transactionId || p.journalId === pair.journalId
    );
    if (conflicts) return;
    const sizeWithPair = matchingSizeWithForced(session, [...accepted, pair]);
    if (sizeWithPair !== k) return;
    possiblePairs.push(pair);
    const sizeWithoutEdge = matchingSizeWithForced(session, accepted, index);
    if (sizeWithoutEdge < k) certainPairs.push(pair);
  });

  const acceptedTransactions = new Set(accepted.map((p) => p.transactionId));
  const acceptedJournals = new Set(accepted.map((p) => p.journalId));
  const possiblyUnmatchedTransactionIds = session.transactionIds.filter(
    (id) =>
      !acceptedTransactions.has(id) &&
      matchingSizeWithForced(session, accepted, -1, id) === k
  );
  const possiblyUnmatchedJournalIds = session.journalIds.filter(
    (id) =>
      !acceptedJournals.has(id) &&
      matchingSizeWithForced(session, accepted, -1, id) === k
  );

  return {
    k,
    certainPairs,
    possiblePairs,
    possiblyUnmatchedTransactionIds: [...possiblyUnmatchedTransactionIds],
    possiblyUnmatchedJournalIds: [...possiblyUnmatchedJournalIds],
  };
}

export function resolve(session: Session, pairs: readonly Pair[]): ResolveResult {
  const combined = [...session.acceptedPairs];
  for (const pair of pairs) {
    if (!combined.some((p) => samePair(p, pair))) {
      combined.push({ transactionId: pair.transactionId, journalId: pair.journalId });
    }
  }
  const valid =
    combined.every((pair) => isCandidate(session, pair)) &&
    !hasConflict(combined) &&
    matchingSizeWithForced(session, combined) ===
      matchingSizeWithForced(session, session.acceptedPairs);
  if (!valid) {
    return { accepted: false, session };
  }
  const next: Session = Object.freeze({
    ...session,
    acceptedPairs: Object.freeze(combined),
  });
  return { accepted: true, session: next };
}
