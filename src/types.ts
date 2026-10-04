export type MessageStatus = 'active' | 'confirmed' | 'exhausted';

export interface SubmitNotificationInput {
  id: string;
  body: string;
  recipient: string;
  notBefore: number;
  critical: boolean;
}

export interface NotificationView {
  id: string;
  body: string;
  recipient: string;
  notBefore: number;
  critical: boolean;
  status: MessageStatus;
}

export interface AttemptView {
  id: string;
  messageId: string;
  seq: number;
  firstStartedAt: number;
  endedAt: number | null;
  endError: string | null;
}

export type DeliverFn = (
  body: string,
  messageId: string,
  attemptId: string,
) => void | Promise<void>;

export interface NotificationServiceOptions {
  dbPath: string;
  deliver: DeliverFn;
}

export interface NotificationService {
  submitNotification(input: SubmitNotificationInput): void;
  advance(now: number): Promise<void>;
  submitReceipt(messageId: string, attemptId: string): void;
  getNotification(id: string): NotificationView | null;
  listAttempts(messageId: string): AttemptView[];
  close(): void;
}
