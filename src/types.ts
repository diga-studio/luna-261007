/** 一条完整的行为事件记录。 */
export interface EventRecord {
  /** 全局唯一事件 ID，ASCII 字符串。 */
  eventId: string;
  /** 匿名用户 ID。 */
  userId: string;
  /** 毫秒时间戳。 */
  timestampMs: number;
  /** 屏幕名称。 */
  screen: string;
}

/** 会话摘要。 */
export interface SessionSummary {
  /** 会话内首事件的 ID，作为会话的稳定标识。 */
  sessionId: string;
  userId: string;
  /** 首事件时间戳（毫秒）。 */
  startMs: number;
  /** 末事件时间戳（毫秒）。 */
  endMs: number;
  /** 持续时长 = endMs - startMs，单事件会话为 0。 */
  durationMs: number;
  /** 会话内有效事件数。 */
  eventCount: number;
  /** 入口屏幕（排序后首事件的屏幕）。 */
  entryScreen: string;
  /** 出口屏幕（排序后末事件的屏幕）。 */
  exitScreen: string;
}
