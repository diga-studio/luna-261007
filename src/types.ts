export type RedemptionStatus =
  | 'pending'
  | 'cancelling'
  | 'completed'
  | 'rejected'
  | 'cancelled';

export interface EmployeeSeed {
  id: string;
  points: number;
}

export interface RewardSeed {
  id: string;
  price: number;
  stock: number;
}

export interface SubmitInput {
  redemptionId: string;
  employeeId: string;
  rewardId: string;
}

export type RejectReason =
  | 'UNKNOWN_EMPLOYEE'
  | 'UNKNOWN_REWARD'
  | 'INSUFFICIENT_POINTS'
  | 'OUT_OF_STOCK'
  | 'QUOTA_EXCEEDED';

export interface RedemptionView {
  id: string;
  employeeId: string;
  rewardId: string;
  quarter: string;
  status: RedemptionStatus;
  attemptsStarted: number;
  cancelRequested: boolean;
}

export interface SubmitResult {
  accepted: boolean;
  reason: RejectReason | null;
  redemption: RedemptionView | null;
}

export interface EmployeeBalance {
  employeeId: string;
  availablePoints: number;
}

export interface RewardStock {
  rewardId: string;
  price: number;
  availableStock: number;
}

export interface QuotaUsage {
  employeeId: string;
  rewardId: string;
  quarter: string;
  used: number;
}

export interface Snapshot {
  takenAt: string;
  employees: EmployeeBalance[];
  rewards: RewardStock[];
  quotaUsage: QuotaUsage[];
  redemptions: RedemptionView[];
}

export type HrHandler = (redemptionId: string) => Promise<void>;

export interface ServiceOptions {
  dbPath?: string;
  employees: EmployeeSeed[];
  rewards: RewardSeed[];
  hrHandler: HrHandler;
  retryDelaysMs?: [number, number];
  now?: () => Date;
}
