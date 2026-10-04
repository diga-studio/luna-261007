import { DatabaseSync } from 'node:sqlite';
import type { AttemptView, MessageStatus, NotificationView } from './types.js';

export interface MessageRow {
  id: string;
  body: string;
  recipient: string;
  notBefore: number;
  critical: boolean;
  status: MessageStatus;
}

export interface AttemptRow {
  id: string;
  messageId: string;
  seq: number;
  firstStartedAt: number;
  endedAt: number | null;
  endError: string | null;
}

interface MessageRecord {
  id: string;
  body: string;
  recipient: string;
  not_before: number;
  critical: number;
  status: string;
}

interface AttemptRecord {
  id: string;
  message_id: string;
  seq: number;
  first_started_at: number;
  ended_at: number | null;
  end_error: string | null;
}

function mapMessage(rec: MessageRecord): MessageRow {
  return {
    id: rec.id,
    body: rec.body,
    recipient: rec.recipient,
    notBefore: rec.not_before,
    critical: rec.critical !== 0,
    status: rec.status as MessageStatus,
  };
}

function mapAttempt(rec: AttemptRecord): AttemptRow {
  return {
    id: rec.id,
    messageId: rec.message_id,
    seq: rec.seq,
    firstStartedAt: rec.first_started_at,
    endedAt: rec.ended_at,
    endError: rec.end_error,
  };
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = FULL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        body TEXT NOT NULL,
        recipient TEXT NOT NULL,
        not_before INTEGER NOT NULL,
        critical INTEGER NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL REFERENCES messages(id),
        seq INTEGER NOT NULL,
        first_started_at INTEGER NOT NULL,
        ended_at INTEGER,
        end_error TEXT,
        UNIQUE(message_id, seq)
      );
      CREATE TABLE IF NOT EXISTS receipts (
        message_id TEXT NOT NULL REFERENCES messages(id),
        attempt_id TEXT NOT NULL REFERENCES attempts(id),
        PRIMARY KEY (message_id, attempt_id)
      );
    `);
  }

  insertMessage(row: MessageRow): void {
    this.db
      .prepare(
        'INSERT INTO messages (id, body, recipient, not_before, critical, status) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(row.id, row.body, row.recipient, row.notBefore, row.critical ? 1 : 0, row.status);
  }

  getMessage(id: string): MessageRow | null {
    const rec = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as
      | MessageRecord
      | undefined;
    return rec ? mapMessage(rec) : null;
  }

  listActiveMessages(): MessageRow[] {
    const recs = this.db
      .prepare("SELECT * FROM messages WHERE status = 'active' ORDER BY rowid")
      .all() as unknown as MessageRecord[];
    return recs.map(mapMessage);
  }

  setMessageStatus(id: string, status: MessageStatus): void {
    this.db.prepare('UPDATE messages SET status = ? WHERE id = ?').run(status, id);
  }

  insertAttempt(row: AttemptRow): void {
    this.db
      .prepare(
        'INSERT INTO attempts (id, message_id, seq, first_started_at, ended_at, end_error) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(row.id, row.messageId, row.seq, row.firstStartedAt, row.endedAt, row.endError);
  }

  markAttemptEnded(attemptId: string, endedAt: number, endError: string | null): void {
    this.db
      .prepare('UPDATE attempts SET ended_at = ?, end_error = ? WHERE id = ?')
      .run(endedAt, endError, attemptId);
  }

  listAttempts(messageId: string): AttemptRow[] {
    const recs = this.db
      .prepare('SELECT * FROM attempts WHERE message_id = ? ORDER BY seq')
      .all(messageId) as unknown as AttemptRecord[];
    return recs.map(mapAttempt);
  }

  getAttempt(attemptId: string): AttemptRow | null {
    const rec = this.db.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptId) as
      | AttemptRecord
      | undefined;
    return rec ? mapAttempt(rec) : null;
  }

  insertReceipt(messageId: string, attemptId: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO receipts (message_id, attempt_id) VALUES (?, ?)')
      .run(messageId, attemptId);
  }

  close(): void {
    this.db.close();
  }
}

export function toNotificationView(row: MessageRow): NotificationView {
  return {
    id: row.id,
    body: row.body,
    recipient: row.recipient,
    notBefore: row.notBefore,
    critical: row.critical,
    status: row.status,
  };
}

export function toAttemptView(row: AttemptRow): AttemptView {
  return {
    id: row.id,
    messageId: row.messageId,
    seq: row.seq,
    firstStartedAt: row.firstStartedAt,
    endedAt: row.endedAt,
    endError: row.endError,
  };
}
