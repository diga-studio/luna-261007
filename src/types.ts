/** Outcome reported by the caller-provided send simulator. */
export type SendOutcome = 'success' | 'failure';

/** A single send invocation handed to the simulator. */
export interface SendRequest {
  subscriberId: string;
  chainId: string;
  stepIndex: number;
  content: string;
  attemptId: string;
}

/**
 * Caller-provided in-process async send simulator.
 * Resolves with the outcome, or may never resolve.
 * Invoked exactly once per attempt.
 */
export type Sender = (request: SendRequest) => Promise<SendOutcome>;

/** Caller-advanceable logical millisecond clock. */
export interface Clock {
  now(): number;
}

/** One step of a fixed message plan carried by a business trigger. */
export interface MessageStep {
  content: string;
  delayMs: number;
}

export type SubscriberEvent =
  | { subscriberId: string; eventId: string; kind: 'consent' }
  | { subscriberId: string; eventId: string; kind: 'stop' }
  | { subscriberId: string; eventId: string; kind: 'trigger'; plan: MessageStep[] };

export type AttemptStatus =
  | 'scheduled'
  | 'started'
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'cancelled';

export interface AttemptRecord {
  attemptId: string;
  /** 0 = initial attempt, 1..3 = retries. */
  attemptNumber: number;
  status: AttemptStatus;
  /** Logical time at which the attempt becomes eligible to start. */
  dueAt: number;
  startedAt: number | null;
  /** Fixed at startedAt + 45s once started. */
  timeoutAt: number | null;
  /** Outcome reported by the simulator, if it ever returned. */
  outcome: SendOutcome | null;
  outcomeAt: number | null;
  /** True when the outcome arrived after the attempt was already resolved. */
  late: boolean;
}

export type StepStatus = 'pending' | 'in_progress' | 'succeeded' | 'failed' | 'cancelled';

export interface StepRecord {
  index: number;
  content: string;
  delayMs: number;
  status: StepStatus;
  /** Logical time at which the step becomes sendable; null until scheduled. */
  dueAt: number | null;
  succeededAt: number | null;
  attempts: AttemptRecord[];
}

export type ChainStatus = 'active' | 'completed' | 'failed' | 'cancelled';

export interface ChainRecord {
  chainId: string;
  subscriberId: string;
  consentPeriodId: number;
  triggerEventId: string;
  createdAt: number;
  status: ChainStatus;
  steps: StepRecord[];
}

export interface ConsentPeriodRecord {
  consentPeriodId: number;
  startedAt: number;
  endedAt: number | null;
  endReason: 'stop' | null;
}

export interface SubscriberRecord {
  subscriberId: string;
  consented: boolean;
  currentConsentPeriodId: number | null;
  consentPeriods: ConsentPeriodRecord[];
  chains: ChainRecord[];
}
