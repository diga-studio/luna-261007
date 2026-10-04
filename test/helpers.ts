import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNotificationService } from '../src/index.js';
import type { DeliverFn, NotificationService } from '../src/index.js';

export interface DeliveryRecord {
  body: string;
  messageId: string;
  attemptId: string;
}

export interface Harness {
  dbPath: string;
  deliveries: DeliveryRecord[];
  open(deliver?: DeliverFn): NotificationService;
  record(body: string, messageId: string, attemptId: string): void;
  pendingDeliver(): DeliverFn;
  cleanup(): void;
}

export function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'notif-test-'));
  const dbPath = join(dir, 'test.db');
  const deliveries: DeliveryRecord[] = [];
  const record = (body: string, messageId: string, attemptId: string) => {
    deliveries.push({ body, messageId, attemptId });
  };
  const open = (deliver?: DeliverFn): NotificationService =>
    createNotificationService({ dbPath, deliver: deliver ?? record });
  const pendingDeliver = (): DeliverFn => (body, messageId, attemptId) => {
    record(body, messageId, attemptId);
    return new Promise<void>(() => {});
  };
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  return { dbPath, deliveries, open, record, pendingDeliver, cleanup };
}

export function utc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
  second = 0,
): number {
  return Date.UTC(year, month - 1, day, hour, minute, second);
}

export const MINUTE = 60 * 1000;

export async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
