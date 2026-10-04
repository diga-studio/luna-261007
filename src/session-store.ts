import type { EventRecord, SessionSummary } from "./types";
import { buildSessions, type Session } from "./sessions";

export { SESSION_GAP_MS } from "./sessions";

interface UserSessions {
  readonly sessions: readonly Session[];
  readonly byEventId: ReadonlyMap<string, Session>;
}

/**
 * 进程内存中的会话重组库。
 * 保存每个用户的有效事件集合，并在查询时给出与
 * “重新排序、重新划分会话”完全一致的结果。
 */
export class SessionStore {
  private readonly eventsByUser = new Map<string, Map<string, EventRecord>>();
  private readonly userOfEvent = new Map<string, string>();
  private readonly sessionsByUser = new Map<string, UserSessions>();

  /** 批量写入完整事件记录；同 ID 覆盖旧记录（不改变所属用户）。 */
  writeBatch(records: readonly EventRecord[]): void {
    for (const record of records) {
      const existingUser = this.userOfEvent.get(record.eventId);
      const userId = existingUser ?? record.userId;
      let userEvents = this.eventsByUser.get(userId);
      if (userEvents === undefined) {
        userEvents = new Map<string, EventRecord>();
        this.eventsByUser.set(userId, userEvents);
      }
      userEvents.set(record.eventId, record);
      this.userOfEvent.set(record.eventId, userId);
      this.sessionsByUser.delete(userId);
    }
  }

  /** 查询指定事件所在会话的摘要；事件不存在时返回 null。 */
  getSessionSummary(eventId: string): SessionSummary | null {
    const session = this.findSession(eventId);
    return session === null ? null : session.summary;
  }

  /** 读取指定事件所在会话的完整事件序列（排序后）；事件不存在时返回 null。 */
  getSessionEvents(eventId: string): EventRecord[] | null {
    const session = this.findSession(eventId);
    return session === null ? null : [...session.events];
  }

  private findSession(eventId: string): Session | null {
    const userId = this.userOfEvent.get(eventId);
    if (userId === undefined) {
      return null;
    }
    return this.sessionsForUser(userId).byEventId.get(eventId) ?? null;
  }

  private sessionsForUser(userId: string): UserSessions {
    let cached = this.sessionsByUser.get(userId);
    if (cached === undefined) {
      const userEvents = this.eventsByUser.get(userId);
      const sessions = buildSessions(userId, userEvents?.values() ?? []);
      const byEventId = new Map<string, Session>();
      for (const session of sessions) {
        for (const event of session.events) {
          byEventId.set(event.eventId, session);
        }
      }
      cached = { sessions, byEventId };
      this.sessionsByUser.set(userId, cached);
    }
    return cached;
  }
}
