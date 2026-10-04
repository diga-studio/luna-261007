import type { EventRecord, SessionSummary } from "./types";

/** 会话切分阈值：相邻事件间隔达到或超过该值即切开。 */
export const SESSION_GAP_MS = 30 * 60 * 1000;

/** 一个会话：摘要 + 排序后的完整事件序列。 */
export interface Session {
  readonly summary: SessionSummary;
  readonly events: readonly EventRecord[];
}

/** 排序规则：时间戳升序，同毫秒按事件 ID 的 ASCII 字典序。 */
export function compareEvents(a: EventRecord, b: EventRecord): number {
  if (a.timestampMs !== b.timestampMs) {
    return a.timestampMs - b.timestampMs;
  }
  if (a.eventId < b.eventId) return -1;
  if (a.eventId > b.eventId) return 1;
  return 0;
}

function summarize(userId: string, events: readonly EventRecord[]): SessionSummary {
  const first = events[0];
  const last = events[events.length - 1];
  return {
    userId,
    sessionId: `${userId}:${first.eventId}`,
    eventCount: events.length,
    startTimeMs: first.timestampMs,
    endTimeMs: last.timestampMs,
    durationMs: last.timestampMs - first.timestampMs,
    entryScreen: first.screen,
    exitScreen: last.screen,
  };
}

/**
 * 对单个用户的全部有效事件重新排序并划分会话。
 * 相邻事件间隔严格小于 30 分钟属于同一会话，达到或超过即切开。
 */
export function buildSessions(
  userId: string,
  records: Iterable<EventRecord>,
): Session[] {
  const events = Array.from(records).sort(compareEvents);
  const sessions: Session[] = [];
  let current: EventRecord[] = [];
  for (const event of events) {
    const prev = current[current.length - 1];
    if (prev !== undefined && event.timestampMs - prev.timestampMs >= SESSION_GAP_MS) {
      sessions.push({ summary: summarize(userId, current), events: current });
      current = [];
    }
    current.push(event);
  }
  if (current.length > 0) {
    sessions.push({ summary: summarize(userId, current), events: current });
  }
  return sessions;
}
