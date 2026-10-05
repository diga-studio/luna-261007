/** A candidate or fixed pair linking one transaction to one journal group. */
export interface Pair {
  transactionId: string;
  journalId: string;
}

/** Result of analyzing a session. */
export interface AnalysisResult {
  /** Maximum number of one-to-one pairs achievable over the candidate graph. */
  k: number;
  /** Pairs present in every optimal solution (includes all accepted rulings). */
  certainPairs: Pair[];
  /** Pairs present in at least one optimal solution. */
  possiblePairs: Pair[];
  /** Transaction IDs unmatched in at least one optimal solution. */
  possiblyUnmatchedTransactionIds: string[];
  /** Journal group IDs unmatched in at least one optimal solution. */
  possiblyUnmatchedJournalIds: string[];
}

/** Outcome of a resolve call. */
export interface ResolveResult {
  accepted: boolean;
}
