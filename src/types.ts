export interface InventoryRecord {
  endpointId: string;
  agentToken: string;
  hostname: string;
  ip: string;
  site: string;
}

export interface ImportRow {
  agentToken?: string;
  hostname: string;
  ip: string;
  site: string;
}

export type ConclusionKind = "matched" | "new" | "ambiguous";

export interface RowConclusion {
  kind: ConclusionKind;
  possibleEndpointIds: string[];
  canBeUnmatched: boolean;
}

export interface Reconciler {
  reconcile(rows: readonly ImportRow[]): RowConclusion[];
}
