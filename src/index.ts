export type { Pair, AnalysisResult, ResolveResult } from "./types.js";
export type { Session } from "./session.js";
import { createSession, analyzeSession, resolveSession } from "./session.js";
import type { Pair, AnalysisResult, ResolveResult } from "./types.js";
import type { Session } from "./session.js";

/** Create an independent session over an immutable candidate snapshot. */
export function create(
  transactionIds: readonly string[],
  journalIds: readonly string[],
  candidatePairs: readonly Pair[],
): Session {
  return createSession(transactionIds, journalIds, candidatePairs);
}

/** Analyze a session: K, certain pairs, possible pairs, possibly-unmatched IDs. */
export function analyze(session: Session): AnalysisResult {
  return analyzeSession(session);
}

/** Append a batch of human rulings; all-or-nothing. */
export function resolve(session: Session, pairs: readonly Pair[]): ResolveResult {
  return resolveSession(session, pairs);
}
