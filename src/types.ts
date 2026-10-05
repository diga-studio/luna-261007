export interface InventoryRecord {
  readonly endpointId: string;
  readonly agentToken: string;
  readonly hostname: string;
  readonly ip: string;
  readonly site: string;
}

export interface ImportRow {
  readonly agentToken?: string;
  readonly hostname: string;
  readonly ip: string;
  readonly site: string;
}

export type EvidenceTier = "token" | "hostname" | "ip";

export type ReconcileVerdict = "matched" | "added" | "ambiguous";

export interface RowReconciliation {
  readonly rowIndex: number;
  readonly verdict: ReconcileVerdict;
  /**
   * Endpoints this row can be matched to in at least one globally optimal
   * assignment. For verdict "matched" this contains exactly one endpoint.
   * For verdict "added" this is empty.
   */
  readonly possibleEndpointIds: readonly string[];
  /** Whether some globally optimal assignment leaves this row unmatched. */
  readonly canBeUnmatched: boolean;
}

export interface Reconciler {
  reconcile(rows: readonly ImportRow[]): RowReconciliation[];
}
