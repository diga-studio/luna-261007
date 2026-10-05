import { Store } from './db.ts';
import type {
  HrHandler,
  RedemptionStatus,
  RedemptionView,
  ServiceOptions,
  Snapshot,
  SubmitInput,
  SubmitResult,
} from './types.ts';

const TERMINAL: RedemptionStatus[] = ['completed', 'rejected', 'cancelled'];
const MAX_ATTEMPTS = 3;

interface Runtime {
  outstanding: number;
  failed: number;
  timers: NodeJS.Timeout[];
}

export class RedemptionNotFoundError extends Error {
  constructor(id: string) {
    super(`redemption not found: ${id}`);
    this.name = 'RedemptionNotFoundError';
  }
}

export function quarterOf(date: Date): string {
  const year = date.getUTCFullYear();
  const quarter = Math.floor(date.getUTCMonth() / 3) + 1;
  return `${year}-Q${quarter}`;
}

export class RedemptionService {
  private readonly store: Store;
  private readonly hrHandler: HrHandler;
  private readonly retryDelaysMs: [number, number];
  private readonly now: () => Date;
  private readonly runtime = new Map<string, Runtime>();

  constructor(options: ServiceOptions) {
    this.store = new Store(options.dbPath ?? ':memory:', options.employees, options.rewards);
    this.hrHandler = options.hrHandler;
    this.retryDelaysMs = options.retryDelaysMs ?? [5000, 10000];
    this.now = options.now ?? (() => new Date());
  }

  submit(input: SubmitInput): SubmitResult {
    const existing = this.store.getRedemption(input.redemptionId);
    if (existing) {
      return { accepted: true, reason: null, redemption: existing };
    }
    const accepted = this.store.acceptRedemption({
      id: input.redemptionId,
      employeeId: input.employeeId,
      rewardId: input.rewardId,
      quarter: quarterOf(this.now()),
      createdAt: this.now().toISOString(),
    });
    if (!accepted.ok) {
      return { accepted: false, reason: accepted.reason, redemption: null };
    }
    const runtime: Runtime = { outstanding: 0, failed: 0, timers: [] };
    this.runtime.set(input.redemptionId, runtime);
    this.startAttempt(input.redemptionId);
    for (const delay of this.retryDelaysMs) {
      const timer = setTimeout(() => this.onRetryTimer(input.redemptionId), delay);
      timer.unref();
      runtime.timers.push(timer);
    }
    return { accepted: true, reason: null, redemption: accepted.redemption };
  }

  cancel(redemptionId: string): RedemptionView {
    const view = this.store.getRedemption(redemptionId);
    if (!view) throw new RedemptionNotFoundError(redemptionId);
    if (TERMINAL.includes(view.status)) return view;
    this.store.setCancelRequested(redemptionId);
    const runtime = this.runtime.get(redemptionId);
    const outstanding = runtime?.outstanding ?? 0;
    if (outstanding === 0) {
      this.clearTimers(redemptionId);
      return this.store.refundAndClose(redemptionId, 'cancelled')!;
    }
    return this.store.setStatus(redemptionId, 'cancelling')!;
  }

  getRedemption(redemptionId: string): RedemptionView | null {
    return this.store.getRedemption(redemptionId);
  }

  snapshot(): Snapshot {
    return this.store.snapshot();
  }

  close(): void {
    for (const id of this.runtime.keys()) this.clearTimers(id);
    this.store.close();
  }

  private onRetryTimer(redemptionId: string): void {
    const view = this.store.getRedemption(redemptionId);
    if (!view || TERMINAL.includes(view.status)) return;
    if (view.cancelRequested) return;
    if (view.attemptsStarted >= MAX_ATTEMPTS) return;
    this.startAttempt(redemptionId);
  }

  private startAttempt(redemptionId: string): void {
    const runtime = this.runtime.get(redemptionId);
    if (!runtime) return;
    this.store.incrementAttempts(redemptionId);
    runtime.outstanding += 1;
    let promise: Promise<void>;
    try {
      promise = this.hrHandler(redemptionId);
    } catch {
      promise = Promise.reject(new Error('hr handler threw synchronously'));
    }
    promise.then(
      () => this.onAttemptSuccess(redemptionId),
      () => this.onAttemptFailure(redemptionId),
    );
  }

  private onAttemptSuccess(redemptionId: string): void {
    const runtime = this.runtime.get(redemptionId);
    if (runtime) runtime.outstanding = Math.max(0, runtime.outstanding - 1);
    const view = this.store.complete(redemptionId);
    if (view && view.status === 'completed') this.clearTimers(redemptionId);
  }

  private onAttemptFailure(redemptionId: string): void {
    const runtime = this.runtime.get(redemptionId);
    if (!runtime) return;
    runtime.outstanding = Math.max(0, runtime.outstanding - 1);
    runtime.failed += 1;
    const view = this.store.getRedemption(redemptionId);
    if (!view || TERMINAL.includes(view.status)) return;
    if (view.cancelRequested && runtime.outstanding === 0) {
      this.clearTimers(redemptionId);
      this.store.refundAndClose(redemptionId, 'cancelled');
      return;
    }
    if (view.attemptsStarted >= MAX_ATTEMPTS && runtime.failed >= MAX_ATTEMPTS) {
      this.clearTimers(redemptionId);
      this.store.refundAndClose(redemptionId, 'rejected');
    }
  }

  private clearTimers(redemptionId: string): void {
    const runtime = this.runtime.get(redemptionId);
    if (!runtime) return;
    for (const timer of runtime.timers) clearTimeout(timer);
    runtime.timers = [];
  }
}

export type { RedemptionStatus, RedemptionView, ServiceOptions, Snapshot, SubmitInput, SubmitResult };
