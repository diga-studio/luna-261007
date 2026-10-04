import { randomUUID } from 'node:crypto';
import { Store, toAttemptView, toNotificationView } from './store.js';
import type {
  AttemptView,
  DeliverFn,
  NotificationService,
  NotificationServiceOptions,
  NotificationView,
  SubmitNotificationInput,
} from './types.js';

export const MAX_ATTEMPTS = 4;
export const RETRY_INTERVAL_MS = 10 * 60 * 1000;
export const DELIVERY_WINDOW_START_HOUR = 8;
export const DELIVERY_WINDOW_END_HOUR = 18;

function deliveryAllowedAt(critical: boolean, notBefore: number, now: number): boolean {
  if (now < notBefore) return false;
  if (!critical) {
    const hour = new Date(now).getUTCHours();
    if (hour < DELIVERY_WINDOW_START_HOUR || hour >= DELIVERY_WINDOW_END_HOUR) return false;
  }
  return true;
}

class NotificationServiceImpl implements NotificationService {
  private readonly store: Store;
  private readonly deliver: DeliverFn;
  private advanceChain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(options: NotificationServiceOptions) {
    this.store = new Store(options.dbPath);
    this.deliver = options.deliver;
  }

  submitNotification(input: SubmitNotificationInput): void {
    if (!input || typeof input.id !== 'string' || input.id.length === 0) {
      throw new Error('notification id must be a non-empty string');
    }
    if (typeof input.body !== 'string') throw new Error('notification body must be a string');
    if (typeof input.recipient !== 'string' || input.recipient.length === 0) {
      throw new Error('notification recipient must be a non-empty string');
    }
    if (typeof input.notBefore !== 'number' || !Number.isFinite(input.notBefore)) {
      throw new Error('notification notBefore must be a finite number (UTC epoch ms)');
    }
    const existing = this.store.getMessage(input.id);
    if (existing) {
      const same =
        existing.body === input.body &&
        existing.recipient === input.recipient &&
        existing.notBefore === input.notBefore &&
        existing.critical === input.critical;
      if (!same) {
        throw new Error(`notification ${input.id} already exists with different content`);
      }
      return;
    }
    this.store.insertMessage({
      id: input.id,
      body: input.body,
      recipient: input.recipient,
      notBefore: input.notBefore,
      critical: input.critical,
      status: 'active',
    });
  }

  advance(now: number): Promise<void> {
    if (typeof now !== 'number' || !Number.isFinite(now)) {
      return Promise.reject(new Error('now must be a finite number (UTC epoch ms)'));
    }
    const run = this.advanceChain.then(() => this.advanceOnce(now));
    this.advanceChain = run.catch(() => {});
    return run;
  }

  submitReceipt(messageId: string, attemptId: string): void {
    const message = this.store.getMessage(messageId);
    if (!message) throw new Error(`unknown message ${messageId}`);
    const attempt = this.store.getAttempt(attemptId);
    if (!attempt || attempt.messageId !== messageId) {
      throw new Error(`attempt ${attemptId} does not belong to message ${messageId}`);
    }
    this.store.insertReceipt(messageId, attemptId);
    if (message.status !== 'confirmed') {
      this.store.setMessageStatus(messageId, 'confirmed');
    }
  }

  getNotification(id: string): NotificationView | null {
    const row = this.store.getMessage(id);
    return row ? toNotificationView(row) : null;
  }

  listAttempts(messageId: string): AttemptView[] {
    return this.store.listAttempts(messageId).map(toAttemptView);
  }

  close(): void {
    this.closed = true;
    this.store.close();
  }

  private async advanceOnce(now: number): Promise<void> {
    for (const message of this.store.listActiveMessages()) {
      const fresh = this.store.getMessage(message.id);
      if (!fresh || fresh.status !== 'active') continue;
      await this.processMessage(fresh.id, fresh.critical, fresh.notBefore, fresh.body, now);
    }
  }

  private async processMessage(
    id: string,
    critical: boolean,
    notBefore: number,
    body: string,
    now: number,
  ): Promise<void> {
    const attempts = this.store.listAttempts(id);
    const last = attempts.length > 0 ? attempts[attempts.length - 1]! : null;
    const inFlight = last !== null && last.endedAt === null;

    if (
      !inFlight &&
      last !== null &&
      last.seq >= MAX_ATTEMPTS &&
      now - last.firstStartedAt >= RETRY_INTERVAL_MS
    ) {
      this.store.setMessageStatus(id, 'exhausted');
      return;
    }

    if (!deliveryAllowedAt(critical, notBefore, now)) return;

    if (inFlight && last !== null) {
      await this.runDelivery(body, id, last.id, now);
      return;
    }

    if (last === null) {
      const attemptId = randomUUID();
      this.store.insertAttempt({
        id: attemptId,
        messageId: id,
        seq: 1,
        firstStartedAt: now,
        endedAt: null,
        endError: null,
      });
      await this.runDelivery(body, id, attemptId, now);
      return;
    }

    if (now - last.firstStartedAt >= RETRY_INTERVAL_MS) {
      const attemptId = randomUUID();
      this.store.insertAttempt({
        id: attemptId,
        messageId: id,
        seq: last.seq + 1,
        firstStartedAt: now,
        endedAt: null,
        endError: null,
      });
      await this.runDelivery(body, id, attemptId, now);
    }
  }

  private async runDelivery(body: string, messageId: string, attemptId: string, now: number): Promise<void> {
    let endError: string | null = null;
    try {
      await this.deliver(body, messageId, attemptId);
    } catch (err) {
      endError = err instanceof Error ? err.message : String(err);
    }
    if (this.closed) return;
    this.store.markAttemptEnded(attemptId, now, endError);
  }
}

export function createNotificationService(options: NotificationServiceOptions): NotificationService {
  return new NotificationServiceImpl(options);
}
