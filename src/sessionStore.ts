import { EventRecord, SessionSummary } from "./types";

/** 会话切分阈值：相邻事件间隔达到或超过 30 分钟即切开。 */
export const SESSION_GAP_MS = 30 * 60 * 1000;

/**
 * 进程内存中的会话重组库。
 *
 * 写入采用“受影响用户全量重算”策略：每批写入落账后，
 * 对涉及用户的有效事件重新排序、重新划分会话，
 * 因此结果与批内记录顺序无关，天然支持乱序补传与修订。
 */
export class SessionStore {
  /** eventId -> 当前有效记录。 */
  private readonly records = new Map<string, EventRecord>();
  /** userId -> 该用户有效事件的 eventId 集合。 */
  private readonly eventIdsByUser = new Map<string, Set<string>>();
  /** userId -> 会话列表（每个会话是按排序规则排列的事件数组）。 */
  private readonly sessionsByUser = new Map<string, EventRecord[][]>();
  /** eventId -> 所在会话（引用 sessionsByUser 中的数组）。 */
  private readonly sessionByEventId = new Map<string, EventRecord[]>();

  /** 批量写入完整事件记录；同 ID 覆盖旧记录（可改时间戳和屏幕）。 */
  writeBatch(records: EventRecord[]): void {
    const affectedUsers = new Set<string>();
    for (const record of records) {
      const previous = this.records.get(record.eventId);
      if (previous !== undefined) {
        const previousIds = this.eventIdsByUser.get(previous.userId);
        if (previousIds !== undefined) {
          previousIds.delete(record.eventId);
          if (previousIds.size === 0) {
            this.eventIdsByUser.delete(previous.userId);
          }
        }
        affectedUsers.add(previous.userId);
      }
      this.records.set(record.eventId, { ...record });
      let ids = this.eventIdsByUser.get(record.userId);
      if (ids === undefined) {
        ids = new Set<string>();
        this.eventIdsByUser.set(record.userId, ids);
      }
      ids.add(record.eventId);
      affectedUsers.add(record.userId);
    }
    for (const userId of affectedUsers) {
      this.rebuildUserSessions(userId);
    }
  }

  /** 查询指定事件所在会话的摘要；事件不存在返回 undefined。 */
  getSessionSummary(eventId: string): SessionSummary | undefined {
    const session = this.sessionByEventId.get(eventId);
    if (session === undefined) {
      return undefined;
    }
    const first = session[0];
    const last = session[session.length - 1];
    return {
      sessionId: first.eventId,
      userId: first.userId,
      startMs: first.timestampMs,
      endMs: last.timestampMs,
      durationMs: last.timestampMs - first.timestampMs,
      eventCount: session.length,
      entryScreen: first.screen,
      exitScreen: last.screen,
    };
  }

  /** 读取指定事件所在会话的完整事件序列（按排序规则）；事件不存在返回 undefined。 */
  getSessionEvents(eventId: string): EventRecord[] | undefined {
    const session = this.sessionByEventId.get(eventId);
    if (session === undefined) {
      return undefined;
    }
    return session.map((record) => ({ ...record }));
  }

  /** 对单个用户的有效事件重新排序并重新划分会话。 */
  private rebuildUserSessions(userId: string): void {
    const ids = this.eventIdsByUser.get(userId);
    const oldSessions = this.sessionsByUser.get(userId);
    if (oldSessions !== undefined) {
      for (const session of oldSessions) {
        for (const record of session) {
          this.sessionByEventId.delete(record.eventId);
        }
      }
    }
    if (ids === undefined || ids.size === 0) {
      this.sessionsByUser.delete(userId);
      return;
    }
    const sorted: EventRecord[] = [];
    for (const eventId of ids) {
      sorted.push(this.records.get(eventId)!);
    }
    sorted.sort(compareEvents);
    const sessions: EventRecord[][] = [];
    let current: EventRecord[] = [];
    for (const record of sorted) {
      if (
        current.length > 0 &&
        record.timestampMs - current[current.length - 1].timestampMs >= SESSION_GAP_MS
      ) {
        sessions.push(current);
        current = [];
      }
      current.push(record);
    }
    if (current.length > 0) {
      sessions.push(current);
    }
    this.sessionsByUser.set(userId, sessions);
    for (const session of sessions) {
      for (const record of session) {
        this.sessionByEventId.set(record.eventId, session);
      }
    }
  }
}

/** 排序规则：时间戳升序；同毫秒按事件 ID 的 ASCII 字典序。 */
function compareEvents(a: EventRecord, b: EventRecord): number {
  if (a.timestampMs !== b.timestampMs) {
    return a.timestampMs - b.timestampMs;
  }
  if (a.eventId < b.eventId) {
    return -1;
  }
  if (a.eventId > b.eventId) {
    return 1;
  }
  return 0;
}
