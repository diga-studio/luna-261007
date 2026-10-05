export type SendOutcome = 'success' | 'failure';

export interface StepPlan {
  content: string;
  delayMs: number;
}

export type MarketingEvent =
  | { kind: 'consent'; subscriberId: string; eventId: string }
  | { kind: 'stop'; subscriberId: string; eventId: string }
  | { kind: 'trigger'; subscriberId: string; eventId: string; plan: StepPlan[] };

export interface SendRequest {
  subscriberId: string;
  chainId: string;
  epoch: number;
  stepIndex: number;
  attemptIndex: number;
  attemptId: string;
  content: string;
}

export type Simulator = (request: SendRequest) => Promise<SendOutcome>;

export type AttemptOutcome = 'success' | 'failure' | 'timeout';

export interface AttemptRecord {
  attemptId: string;
  chainId: string;
  subscriberId: string;
  epoch: number;
  stepIndex: number;
  attemptIndex: number;
  content: string;
  startedAt: number;
  timeoutAt: number;
  outcome: AttemptOutcome | null;
  outcomeAt: number | null;
  lateResult: SendOutcome | null;
  lateResultAt: number | null;
}

export type StepStatus = 'pending' | 'in_progress' | 'succeeded' | 'failed' | 'cancelled';

export interface StepView {
  stepIndex: number;
  content: string;
  delayMs: number;
  status: StepStatus;
  dueAt: number | null;
  succeededAt: number | null;
}

export type ChainStatus = 'active' | 'completed' | 'terminated';

export type ChainEndReason = 'completed' | 'retries_exhausted' | 'stopped' | null;

export interface ChainView {
  chainId: string;
  subscriberId: string;
  epoch: number;
  triggerEventId: string;
  createdAt: number;
  status: ChainStatus;
  endReason: ChainEndReason;
  steps: StepView[];
}
