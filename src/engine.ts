import { LogicalClock } from './clock.ts';
import type {
  AttemptRecord,
  ChainEndReason,
  ChainStatus,
  ChainView,
  MarketingEvent,
  SendOutcome,
  Simulator,
  StepPlan,
  StepStatus,
} from './types.ts';

export const ATTEMPT_TIMEOUT_MS = 45_000;
export const RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000] as const;
export const MAX_ATTEMPTS = 1 + RETRY_DELAYS_MS.length;

export interface AdvanceResult {
  startedAttempts: number;
  timedOutAttempts: number;
}

interface AttemptState {
  rec: AttemptRecord;
  retryConsumed: boolean;
}

interface StepState {
  plan: StepPlan;
  status: StepStatus;
  dueAt: number | null;
  succeededAt: number | null;
  attempts: AttemptState[];
}

interface ChainState {
  chainId: string;
  subscriberId: string;
  epoch: number;
  triggerEventId: string;
  createdAt: number;
  status: ChainStatus;
  endReason: ChainEndReason;
  steps: StepState[];
}

interface SubscriberState {
  subscriberId: string;
  epoch: number;
  consented: boolean;
}

export class MarketingAutomation {
  private readonly simulator: Simulator;
  private readonly clock: LogicalClock;
  private readonly processedEvents = new Set<string>();
  private readonly subscribers = new Map<string, SubscriberState>();
  private readonly chains = new Map<string, ChainState>();
  private readonly chainsBySubscriber = new Map<string, ChainState[]>();
  private idCounter = 0;

  constructor(simulator: Simulator, clock: LogicalClock = new LogicalClock()) {
    this.simulator = simulator;
    this.clock = clock;
  }

  now(): number {
    return this.clock.now();
  }

  async submitEvent(event: MarketingEvent): Promise<void> {
    this.validateEvent(event);
    const key = `${event.subscriberId} ${event.eventId}`;
    if (this.processedEvents.has(key)) {
      return;
    }
    this.processedEvents.add(key);
    const subscriber = this.subscriberOf(event.subscriberId);
    switch (event.kind) {
      case 'consent':
        if (!subscriber.consented) {
          subscriber.epoch += 1;
          subscriber.consented = true;
        }
        return;
      case 'stop':
        if (subscriber.consented) {
          subscriber.consented = false;
          this.terminateActiveChains(subscriber, 'stopped');
        }
        return;
      case 'trigger':
        if (subscriber.consented) {
          this.createChain(subscriber, event.eventId, event.plan);
        }
        return;
    }
  }

  async advanceQueue(): Promise<AdvanceResult> {
    const now = this.clock.now();
    let timedOutAttempts = 0;
    for (const chain of this.chains.values()) {
      for (const step of chain.steps) {
        for (const attempt of step.attempts) {
          if (attempt.rec.outcome === null && attempt.rec.timeoutAt <= now) {
            attempt.rec.outcome = 'timeout';
            attempt.rec.outcomeAt = attempt.rec.timeoutAt;
            timedOutAttempts += 1;
            this.consumeRetry(chain, step, attempt, attempt.rec.timeoutAt);
          }
        }
      }
    }
    let startedAttempts = 0;
    for (const chain of this.chains.values()) {
      if (chain.status !== 'active') continue;
      const step = chain.steps.find((s) => s.dueAt !== null && s.dueAt <= now);
      if (!step) continue;
      if (step.attempts.length >= MAX_ATTEMPTS) continue;
      this.startAttempt(chain, step);
      startedAttempts += 1;
    }
    return { startedAttempts, timedOutAttempts };
  }

  getChains(subscriberId?: string): ChainView[] {
    const source =
      subscriberId === undefined
        ? [...this.chains.values()]
        : (this.chainsBySubscriber.get(subscriberId) ?? []);
    return source.map((chain) => this.chainView(chain));
  }

  getAttempts(chainId: string): AttemptRecord[] {
    const chain = this.chains.get(chainId);
    if (!chain) return [];
    return chain.steps
      .flatMap((step) => step.attempts.map((attempt) => attempt.rec))
      .sort((a, b) => a.startedAt - b.startedAt || a.attemptIndex - b.attemptIndex)
      .map((rec) => ({ ...rec }));
  }

  private subscriberOf(subscriberId: string): SubscriberState {
    let subscriber = this.subscribers.get(subscriberId);
    if (!subscriber) {
      subscriber = { subscriberId, epoch: 0, consented: false };
      this.subscribers.set(subscriberId, subscriber);
    }
    return subscriber;
  }

  private nextId(prefix: string): string {
    this.idCounter += 1;
    return `${prefix}_${this.idCounter}`;
  }

  private validateEvent(event: MarketingEvent): void {
    if (!event.subscriberId || !event.eventId) {
      throw new Error('event requires subscriberId and eventId');
    }
    if (event.kind === 'trigger') {
      const plan = event.plan;
      if (!Array.isArray(plan) || plan.length < 1 || plan.length > 5) {
        throw new Error('trigger plan must contain 1 to 5 steps');
      }
      for (const step of plan) {
        if (typeof step.content !== 'string') {
          throw new Error('step content must be a string');
        }
        if (!Number.isFinite(step.delayMs) || step.delayMs < 0) {
          throw new Error('step delayMs must be a non-negative number');
        }
      }
    }
  }

  private createChain(subscriber: SubscriberState, triggerEventId: string, plan: StepPlan[]): void {
    const now = this.clock.now();
    const chain: ChainState = {
      chainId: this.nextId('chain'),
      subscriberId: subscriber.subscriberId,
      epoch: subscriber.epoch,
      triggerEventId,
      createdAt: now,
      status: 'active',
      endReason: null,
      steps: plan.map((stepPlan, index) => ({
        plan: { content: stepPlan.content, delayMs: stepPlan.delayMs },
        status: 'pending',
        dueAt: index === 0 ? now + stepPlan.delayMs : null,
        succeededAt: null,
        attempts: [],
      })),
    };
    this.chains.set(chain.chainId, chain);
    let list = this.chainsBySubscriber.get(subscriber.subscriberId);
    if (!list) {
      list = [];
      this.chainsBySubscriber.set(subscriber.subscriberId, list);
    }
    list.push(chain);
  }

  private terminateActiveChains(subscriber: SubscriberState, reason: ChainEndReason): void {
    const list = this.chainsBySubscriber.get(subscriber.subscriberId) ?? [];
    for (const chain of list) {
      if (chain.status !== 'active') continue;
      chain.status = 'terminated';
      chain.endReason = reason;
      for (const step of chain.steps) {
        if (step.status === 'succeeded') continue;
        step.status = 'cancelled';
        step.dueAt = null;
      }
    }
  }

  private startAttempt(chain: ChainState, step: StepState): void {
    const now = this.clock.now();
    const attemptIndex = step.attempts.length;
    const rec: AttemptRecord = {
      attemptId: this.nextId('att'),
      chainId: chain.chainId,
      subscriberId: chain.subscriberId,
      epoch: chain.epoch,
      stepIndex: chain.steps.indexOf(step),
      attemptIndex,
      content: step.plan.content,
      startedAt: now,
      timeoutAt: now + ATTEMPT_TIMEOUT_MS,
      outcome: null,
      outcomeAt: null,
      lateResult: null,
      lateResultAt: null,
    };
    const attempt: AttemptState = { rec, retryConsumed: false };
    step.attempts.push(attempt);
    step.status = 'in_progress';
    step.dueAt = null;
    let promise: Promise<SendOutcome>;
    try {
      promise = this.simulator({
        subscriberId: rec.subscriberId,
        chainId: rec.chainId,
        epoch: rec.epoch,
        stepIndex: rec.stepIndex,
        attemptIndex: rec.attemptIndex,
        attemptId: rec.attemptId,
        content: rec.content,
      });
    } catch {
      promise = Promise.resolve('failure');
    }
    Promise.resolve(promise).then(
      (outcome) =>
        this.onAttemptResult(chain, step, attempt, outcome === 'success' ? 'success' : 'failure'),
      () => this.onAttemptResult(chain, step, attempt, 'failure'),
    );
  }

  private onAttemptResult(
    chain: ChainState,
    step: StepState,
    attempt: AttemptState,
    outcome: SendOutcome,
  ): void {
    const now = this.clock.now();
    const rec = attempt.rec;
    if (rec.outcome !== null) {
      rec.lateResult = outcome;
      rec.lateResultAt = now;
      if (outcome === 'success') {
        this.trySucceedStep(chain, step, now);
      }
      return;
    }
    if (now >= rec.timeoutAt) {
      rec.outcome = 'timeout';
      rec.outcomeAt = rec.timeoutAt;
      rec.lateResult = outcome;
      rec.lateResultAt = now;
      this.consumeRetry(chain, step, attempt, rec.timeoutAt);
      if (outcome === 'success') {
        this.trySucceedStep(chain, step, now);
      }
      return;
    }
    rec.outcome = outcome;
    rec.outcomeAt = now;
    if (outcome === 'success') {
      this.trySucceedStep(chain, step, now);
    } else {
      this.consumeRetry(chain, step, attempt, now);
    }
  }

  private trySucceedStep(chain: ChainState, step: StepState, at: number): void {
    if (chain.status !== 'active') return;
    const subscriber = this.subscribers.get(chain.subscriberId);
    if (!subscriber || !subscriber.consented || subscriber.epoch !== chain.epoch) return;
    if (step.status === 'succeeded' || step.status === 'failed' || step.status === 'cancelled') {
      return;
    }
    step.status = 'succeeded';
    step.succeededAt = at;
    step.dueAt = null;
    const stepIndex = chain.steps.indexOf(step);
    if (stepIndex === chain.steps.length - 1) {
      chain.status = 'completed';
      chain.endReason = 'completed';
      return;
    }
    const next = chain.steps[stepIndex + 1];
    next.dueAt = at + next.plan.delayMs;
  }

  private consumeRetry(chain: ChainState, step: StepState, attempt: AttemptState, at: number): void {
    if (attempt.retryConsumed) return;
    attempt.retryConsumed = true;
    if (chain.status !== 'active') return;
    if (step.status === 'succeeded') return;
    if (step.attempts.length >= MAX_ATTEMPTS) {
      chain.status = 'terminated';
      chain.endReason = 'retries_exhausted';
      const failedIndex = chain.steps.indexOf(step);
      chain.steps.forEach((s, index) => {
        if (index === failedIndex) {
          s.status = 'failed';
        } else if (s.status !== 'succeeded') {
          s.status = 'cancelled';
        }
        s.dueAt = null;
      });
      return;
    }
    step.dueAt = at + RETRY_DELAYS_MS[attempt.rec.attemptIndex];
  }

  private chainView(chain: ChainState): ChainView {
    return {
      chainId: chain.chainId,
      subscriberId: chain.subscriberId,
      epoch: chain.epoch,
      triggerEventId: chain.triggerEventId,
      createdAt: chain.createdAt,
      status: chain.status,
      endReason: chain.endReason,
      steps: chain.steps.map((step, index) => ({
        stepIndex: index,
        content: step.plan.content,
        delayMs: step.plan.delayMs,
        status: step.status,
        dueAt: step.dueAt,
        succeededAt: step.succeededAt,
      })),
    };
  }
}
