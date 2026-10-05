export type TransactionId = string;
export type JournalId = string;

export interface Pair {
  transactionId: TransactionId;
  journalId: JournalId;
}

export interface AnalysisResult {
  /** Maximum one-to-one matching size achievable under current rulings. */
  k: number;
  /** Pairs present in every optimal solution. */
  certainPairs: Pair[];
  /** Pairs present in at least one optimal solution. */
  possiblePairs: Pair[];
  /** Transaction ids unmatched in at least one optimal solution. */
  possiblyUnmatchedTransactionIds: TransactionId[];
  /** Journal ids unmatched in at least one optimal solution. */
  possiblyUnmatchedJournalIds: JournalId[];
}

export interface Session {
  readonly transactionIds: readonly TransactionId[];
  readonly journalIds: readonly JournalId[];
  readonly candidatePairs: readonly Pair[];
  readonly acceptedPairs: readonly Pair[];
}

export type ResolveResult =
  | { accepted: true; session: Session }
  | { accepted: false; session: Session };
