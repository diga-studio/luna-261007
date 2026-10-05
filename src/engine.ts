import type {
  AttemptRecord,
  AttemptStatus,
  ChainRecord,
  ChainStatus,
  Clock,
  SendOutcome,
  Sender,
  StepRecord,
  StepStatus,
  SubscriberEvent,
  SubscriberRecord,
} from './types.js';

export const ATTEMPT_TIMEOUT_MS = 45_000;
export const RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000] as const;
export const MAX_RETRIES = 3;
export const MIN_PLAN_STEPS = 1;
export const MAX_PLAN_STEPS = 5;

export interface MarketingAutomationOptions {
  sender: Sender;
  clock: Clock;
}

interface ConsentPeriodState {
  id: number;
  startedAt: number;
  endedAt: number | null;
  endReason: 'stop' | null;
}

interface AttemptState {
  attemptId: string;
  attemptNumber: number;
  status: AttemptStatus;
  dueAt: number;
  startedAt: number | null;
  timeoutAt: number | null;
  outcome: SendOutcome | null;
  outcomeAt: number | null;
  late: boolean;
  step: StepState;
}

interface StepState {
  index: number;
  content: string;
  delayMs: number;
  status: StepStatus;
  dueAt: number | null;
  succeededAt: number | null;
  attempts: AttemptState[];
  chain: ChainState;
}

interface ChainState {
  chainId: string;
  subscriberId: string;
  consentPeriodId: number;
  triggerEventId: string;
  createdAt: number;
  status: ChainStatus;
  steps: StepState[];
}

interface SubscriberState {
  id: string;
  consented: boolean;
  currentPeriodId: number | null;
  periods: ConsentPeriodState[];
  chains: ChainState[];
}

/**
 * In-process marketing automation send engine.
 * State lives in memory; the caller drives time via the logical clock
 * and starts due attempts by calling advanceQueue().
 */
export class MarketingAutomation {
  private readonly sender: Sender;
  private readonly clock: Clock;
  private readonly subscribers = new Map<string, SubscriberState>();
  private readonly chainsById = new Map<string, ChainState>();
  private readonly acceptedEvents = new Set<string>();
  private readonly scheduledAttempts = new Set<AttemptState>();
  private readonly startedAttempts = new Set<AttemptState>();
  private mutex: Promise<void> = Promise.resolve();
  private chainSeq = 0;
  private attemptSeq = 0;

  constructor(options: MarketingAutomationOptions) {
    this.sender = options.sender;
    this.clock = options.clock;
  }

  /** Accept a subscriber event. Replays of an accepted event have no effect. */
  submitEvent(event: SubscriberEvent): Promise<void> {
    this.validateEvent(event);
    return this.enqueue(() => this.applyEvent(event));
  }

  /** Start all attempts currently eligible. Never awaits send results. */
  advanceQueue(): Promise<void> {
    return this.enqueue(() => {
      this.reconcileTimeouts();
      this.startDueAttempts();
    });
  }

  getSubscriber(subscriberId: string): SubscriberRecord | undefined {
    this.reconcileTimeouts();
    const sub = this.subscribers.get(subscriberId);
    return sub ? this.subscriberToRecord(sub) : undefined;
  }

  getChain(chainId: string): ChainRecord | undefined {
    this.reconcileTimeouts();
    const chain = this.chainsById.get(chainId);
    return chain ? this.chainToRecord(chain) : undefined;
  }

  /** Serialize event acceptance and queue advancement. */
  private enqueue(op: () => void): Promise<void> {
    const run = this.mutex.then(op);
    this.mutex = run.catch(() => {});
    return run;
  }

  private validateEvent(event: SubscriberEvent): void {
    if (!event || typeof event.subscriberId !== 'string' || event.subscriberId.length === 0) {
      throw new Error('event.subscriberId must be a non-empty string');
    }
    if (typeof event.eventId !== 'string' || event.eventId.length === 0) {
      throw new Error('event.eventId must be a non-empty string');
    }
    if (event.kind === 'trigger') {
      if (!Array.isArray(event.plan) ||
          event.plan.length < MIN_PLAN_STEPS ||
          event.plan.length > MAX_PLAN_STEPS) {
        throw new Error(`trigger plan must have ${MIN_PLAN_STEPS}..${MAX_PLAN_STEPS} steps`);
      }
      for (const step of event.plan) {
        if (typeof step.content !== 'string') {
          throw new Error('plan step content must be a string');
        }
        if (typeof step.delayMs !== 'number' || !Number.isFinite(step.delayMs) || step.delayMs < 0) {
          throw new Error('plan step delayMs must be a non-negative number');
        }
      }
    } else if (event.kind !== 'consent' && event.kind !== 'stop') {
      throw new Error(`unknown event kind: ${String((event as { kind: unknown }).kind)}`);
    }
  }

  private applyEvent(event: SubscriberEvent): void {
    const key = `${event.subscriberId}\n${event.eventId}`;
    if (this.acceptedEvents.has(key)) return;
    this.acceptedEvents.add(key);
    const now = this.clock.now();
    const sub = this.getOrCreateSubscriber(event.subscriberId);
    switch (event.kind) {
      case 'consent':
        if (!sub.consented) {
          const period: ConsentPeriodState = {
            id: sub.periods.length + 1,
            startedAt: now,
            endedAt: null,
            endReason: null,
          };
          sub.periods.push(period);
          sub.consented = true;
          sub.currentPeriodId = period.id;
        }
        break;
      case 'stop':
        if (sub.consented && sub.currentPeriodId !== null) {
          const period = sub.periods[sub.currentPeriodId - 1];
          if (period) {
            period.endedAt = now;
            period.endReason = 'stop';
          }
          sub.consented = false;
          sub.currentPeriodId = null;
          this.cancelChainsForPeriod(sub, period?.id ?? -1);
        }
        break;
      case 'trigger':
        if (sub.consented && sub.currentPeriodId !== null) {
          this.createChain(sub, event, now);
        }
        break;
    }
  }

  private getOrCreateSubscriber(id: string): SubscriberState {
    let sub = this.subscribers.get(id);
    if (!sub) {
      sub = { id, consented: false, currentPeriodId: null, periods: [], chains: [] };
      this.subscribers.set(id, sub);
    }
    return sub;
  }

  private createChain(
    sub: SubscriberState,
    event: Extract<SubscriberEvent, { kind: 'trigger' }>,
    now: number,
  ): void {
    const chain: ChainState = {
      chainId: `chain-${++this.chainSeq}`,
      subscriberId: sub.id,
      consentPeriodId: sub.currentPeriodId as number,
      triggerEventId: event.eventId,
      createdAt: now,
      status: 'active',
      steps: [],
    };
    chain.steps = event.plan.map((step, index) => ({
      index,
      content: step.content,
      delayMs: step.delayMs,
      status: index === 0 ? 'in_progress' : 'pending',
      dueAt: index === 0 ? now + step.delayMs : null,
      succeededAt: null,
      attempts: [],
      chain,
    }));
    sub.chains.push(chain);
    this.chainsById.set(chain.chainId, chain);
    const first = chain.steps[0];
    if (first) this.scheduleAttempt(first, first.dueAt as number, 0);
  }

  private cancelChainsForPeriod(sub: SubscriberState, periodId: number): void {
    for (const chain of sub.chains) {
      if (chain.consentPeriodId !== periodId || chain.status !== 'active') continue;
      chain.status = 'cancelled';
      for (const step of chain.steps) {
        if (step.status === 'pending' || step.status === 'in_progress') {
          step.status = 'cancelled';
        }
        for (const attempt of step.attempts) {
          if (attempt.status === 'scheduled') {
            attempt.status = 'cancelled';
            this.scheduledAttempts.delete(attempt);
          }
        }
      }
    }
  }

  private isConsentValid(chain: ChainState): boolean {
    const sub = this.subscribers.get(chain.subscriberId);
    return sub !== undefined && sub.consented && sub.currentPeriodId === chain.consentPeriodId;
  }

  private reconcileTimeouts(): void {
    const now = this.clock.now();
    for (const attempt of [...this.startedAttempts]) {
      if (attempt.timeoutAt !== null && now >= attempt.timeoutAt) {
        this.timeoutAttempt(attempt);
      }
    }
  }

  private timeoutAttempt(attempt: AttemptState): void {
    attempt.status = 'timed_out';
    this.startedAttempts.delete(attempt);
    this.consumeRetry(attempt, attempt.timeoutAt as number);
  }

  /** A failure or timeout consumes exactly one retry slot. */
  private consumeRetry(attempt: AttemptState, at: number): void {
    const step = attempt.step;
    const chain = step.chain;
    if (chain.status !== 'active' || step.status !== 'in_progress') return;
    if (!this.isConsentValid(chain)) return;
    const nextNumber = attempt.attemptNumber + 1;
    if (nextNumber > MAX_RETRIES) {
      chain.status = 'failed';
      step.status = 'failed';
      for (const other of step.attempts) {
        if (other.status === 'scheduled') {
          other.status = 'cancelled';
          this.scheduledAttempts.delete(other);
        }
      }
      return;
    }
    this.scheduleAttempt(step, at + (RETRY_DELAYS_MS[nextNumber - 1] as number), nextNumber);
  }

  private scheduleAttempt(step: StepState, dueAt: number, attemptNumber: number): AttemptState {
    const attempt: AttemptState = {
      attemptId: `att-${++this.attemptSeq}`,
      attemptNumber,
      status: 'scheduled',
      dueAt,
      startedAt: null,
      timeoutAt: null,
      outcome: null,
      outcomeAt: null,
      late: false,
      step,
    };
    step.attempts.push(attempt);
    this.scheduledAttempts.add(attempt);
    return attempt;
  }

  private startDueAttempts(): void {
    const now = this.clock.now();
    for (const attempt of [...this.scheduledAttempts]) {
      if (attempt.status !== 'scheduled' || attempt.dueAt > now) continue;
      const step = attempt.step;
      const chain = step.chain;
      if (chain.status !== 'active' || step.status !== 'in_progress') continue;
      if (!this.isConsentValid(chain)) continue;
      this.startAttempt(attempt, now);
    }
  }

  private startAttempt(attempt: AttemptState, now: number): void {
    const step = attempt.step;
    const chain = step.chain;
    this.scheduledAttempts.delete(attempt);
    attempt.status = 'started';
    attempt.startedAt = now;
    attempt.timeoutAt = now + ATTEMPT_TIMEOUT_MS;
    this.startedAttempts.add(attempt);
    let promise: Promise<SendOutcome>;
    try {
      promise = this.sender({
        subscriberId: chain.subscriberId,
        chainId: chain.chainId,
        stepIndex: step.index,
        content: step.content,
        attemptId: attempt.attemptId,
      });
    } catch {
      promise = Promise.resolve('failure');
    }
    Promise.resolve(promise).then(
      (outcome) => this.onOutcome(attempt, outcome === 'success' ? 'success' : 'failure'),
      () => this.onOutcome(attempt, 'failure'),
    );
  }

  private onOutcome(attempt: AttemptState, outcome: SendOutcome): void {
    const at = this.clock.now();
    attempt.outcome = outcome;
    attempt.outcomeAt = at;
    if (attempt.status === 'started') {
      this.startedAttempts.delete(attempt);
      if (attempt.timeoutAt !== null && at >= attempt.timeoutAt) {
        // Returned at or after the 45s mark: the timeout wins.
        attempt.late = true;
        attempt.status = 'timed_out';
        this.consumeRetry(attempt, attempt.timeoutAt);
        if (outcome === 'success') this.tryStepSuccess(attempt, at);
      } else if (outcome === 'success') {
        attempt.status = 'succeeded';
        this.tryStepSuccess(attempt, at);
      } else {
        attempt.status = 'failed';
        this.consumeRetry(attempt, at);
      }
    } else {
      // Attempt already resolved (timeout, STOP, or step completed elsewhere).
      attempt.late = true;
      if (outcome === 'success') this.tryStepSuccess(attempt, at);
      // A late failure never schedules another retry.
    }
  }

  private tryStepSuccess(attempt: AttemptState, at: number): void {
    const step = attempt.step;
    const chain = step.chain;
    if (step.status !== 'in_progress') return;
    if (chain.status !== 'active') return;
    if (!this.isConsentValid(chain)) return;
    step.status = 'succeeded';
    step.succeededAt = at;
    for (const other of step.attempts) {
      if (other.status === 'scheduled') {
        other.status = 'cancelled';
        this.scheduledAttempts.delete(other);
      }
    }
    const next = chain.steps[step.index + 1];
    if (!next) {
      chain.status = 'completed';
      return;
    }
    next.status = 'in_progress';
    next.dueAt = at + next.delayMs;
    this.scheduleAttempt(next, next.dueAt, 0);
  }

  private attemptToRecord(attempt: AttemptState): AttemptRecord {
    return {
      attemptId: attempt.attemptId,
      attemptNumber: attempt.attemptNumber,
      status: attempt.status,
      dueAt: attempt.dueAt,
      startedAt: attempt.startedAt,
      timeoutAt: attempt.timeoutAt,
      outcome: attempt.outcome,
      outcomeAt: attempt.outcomeAt,
      late: attempt.late,
    };
  }

  private stepToRecord(step: StepState): StepRecord {
    return {
      index: step.index,
      content: step.content,
      delayMs: step.delayMs,
      status: step.status,
      dueAt: step.dueAt,
      succeededAt: step.succeededAt,
      attempts: step.attempts.map((attempt) => this.attemptToRecord(attempt)),
    };
  }

  private chainToRecord(chain: ChainState): ChainRecord {
    return {
      chainId: chain.chainId,
      subscriberId: chain.subscriberId,
      consentPeriodId: chain.consentPeriodId,
      triggerEventId: chain.triggerEventId,
      createdAt: chain.createdAt,
      status: chain.status,
      steps: chain.steps.map((step) => this.stepToRecord(step)),
    };
  }

  private subscriberToRecord(sub: SubscriberState): SubscriberRecord {
    return {
      subscriberId: sub.id,
      consented: sub.consented,
      currentConsentPeriodId: sub.currentPeriodId,
      consentPeriods: sub.periods.map((period) => ({
        consentPeriodId: period.id,
        startedAt: period.startedAt,
        endedAt: period.endedAt,
        endReason: period.endReason,
      })),
      chains: sub.chains.map((chain) => this.chainToRecord(chain)),
    };
  }
}
