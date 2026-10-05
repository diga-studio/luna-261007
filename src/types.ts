export type Tier = 'starter' | 'growth' | 'enterprise';

export type InstanceState = 'running' | 'provisioning' | 'paused' | 'terminated';

export interface Snapshot {
  state: InstanceState;
  tier: Tier;
  cpu: number;
}

export interface Change {
  instanceId: string;
  changeId: string;
  revision: number;
  /** UTC epoch milliseconds when this revision takes effect. */
  at: number;
  /** Present for upserts, absent for revocations. */
  snapshot?: Snapshot;
}

export interface LedgerRow {
  instanceId: string;
  /** UTC month key, e.g. "2024-02". */
  month: string;
  /** Signed delta in integer cents appended by a settle. */
  deltaCents: number;
  /** The settle cutoff (UTC ms) that produced this row. */
  settledUntil: number;
}
