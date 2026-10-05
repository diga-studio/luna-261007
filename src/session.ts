import { analyzeSnapshot, rulingsAreFeasible, type Snapshot } from "./analysis.js";
import type { AnalysisResult, Pair, ResolveResult } from "./types.js";

/** An independent reconciliation session over an immutable snapshot. */
export interface Session {
  readonly snapshot: Snapshot;
  /** Accepted rulings so far, in acceptance order. */
  readonly rulings: readonly Pair[];
}

/** Internal mutable state behind the Session facade. */
interface SessionState {
  snapshot: Snapshot;
  rulings: Pair[];
}

const states = new WeakMap<Session, SessionState>();

function assertUniqueIds(ids: readonly string[], kind: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(`${kind} id must be a non-empty string`);
    }
    if (seen.has(id)) {
      throw new Error(`duplicate ${kind} id: ${id}`);
    }
    seen.add(id);
  }
}

export function createSession(
  transactionIds: readonly string[],
  journalIds: readonly string[],
  candidatePairs: readonly Pair[],
): Session {
  assertUniqueIds(transactionIds, "transaction");
  assertUniqueIds(journalIds, "journal");
  const tSet = new Set(transactionIds);
  const jSet = new Set(journalIds);
  for (const p of candidatePairs) {
    if (!tSet.has(p.transactionId)) {
      throw new Error(`candidate pair references unknown transaction id: ${p.transactionId}`);
    }
    if (!jSet.has(p.journalId)) {
      throw new Error(`candidate pair references unknown journal id: ${p.journalId}`);
    }
  }
  // Immutable snapshot: deep-copied, frozen; later input mutations cannot leak in.
  const snapshot: Snapshot = Object.freeze({
    transactionIds: Object.freeze([...transactionIds]),
    journalIds: Object.freeze([...journalIds]),
    candidatePairs: Object.freeze(
      candidatePairs.map((p) => Object.freeze({ transactionId: p.transactionId, journalId: p.journalId })),
    ),
  });
  const state: SessionState = { snapshot, rulings: [] };
  const session: Session = {
    snapshot,
    get rulings() {
      return Object.freeze(state.rulings.map((p) => Object.freeze({ ...p })));
    },
  };
  states.set(session, state);
  return session;
}

export function analyzeSession(session: Session): AnalysisResult {
  const state = states.get(session);
  if (!state) throw new Error("not a session created by create()");
  return analyzeSnapshot(state.snapshot, state.rulings);
}

/**
 * Append a batch of human rulings. Accepts (mutating the session) only if
 * old and new rulings together fit in one optimal solution; otherwise the
 * whole batch is rejected and the session is left unchanged.
 */
export function resolveSession(session: Session, pairs: readonly Pair[]): ResolveResult {
  const state = states.get(session);
  if (!state) throw new Error("not a session created by create()");
  const combined = [...state.rulings, ...pairs];
  if (!rulingsAreFeasible(state.snapshot, combined)) {
    return { accepted: false };
  }
  for (const p of pairs) {
    state.rulings.push({ transactionId: p.transactionId, journalId: p.journalId });
  }
  return { accepted: true };
}
