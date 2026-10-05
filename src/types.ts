export type Decision = 'confirm' | 'revoke';

export type GrantStatus = 'active' | 'suspended' | 'revoked';

export interface GrantInput {
  user: string;
  database: string;
  role: string;
}

export interface DecisionInput {
  entryId: number;
  decision: Decision;
}

export interface GrantState {
  grantId: number;
  user: string;
  database: string;
  role: string;
  status: GrantStatus;
  revoked: boolean;
  suspended: boolean;
}

export interface ReviewCycleInfo {
  cycleId: number;
  database: string;
  openedAt: number;
  deadline: number;
  entryIds: number[];
}
