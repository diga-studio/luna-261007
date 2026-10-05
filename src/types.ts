export type Tier = "starter" | "growth" | "enterprise";

export type ResourceState =
  | "provisioning"
  | "running"
  | "paused"
  | "terminated";

export interface Snapshot {
  state: ResourceState;
  tier: Tier;
  cpu: number;
}

/**
 * A resource change. `snapshot` present => upsert revision of the resource
 * state effective from `at`; `snapshot` absent => revocation of changeId.
 */
export interface Change {
  instanceId: string;
  changeId: string;
  revision: number;
  at: number;
  snapshot?: Snapshot;
}

export interface LedgerRow {
  id: number;
  instanceId: string;
  month: string;
  amountCents: number;
}

export const TIER_MONTHLY_CENTS: Record<Tier, number> = {
  starter: 2900,
  growth: 9900,
  enterprise: 29900,
};

export const TIER_CPU_BASELINE: Record<Tier, number> = {
  starter: 1,
  growth: 4,
  enterprise: 8,
};

export const EXTRA_CPU_CENTS_PER_HOUR = 500;
