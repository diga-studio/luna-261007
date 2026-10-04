/** 一条完整的行为事件记录。 */
export interface EventRecord {
  /** 全局唯一事件 ID，ASCII 字符串。 */
  readonly eventId: string;
  /** 匿名用户 ID。 */
  readonly userId: string;
  /** 毫秒时间戳。 */
  readonly timestampMs: number;
  /** 屏幕名称。 */
  readonly screen: string;
}

/** 会话摘要。 */
export interface SessionSummary {
  /** 会话所属用户。 */
  readonly userId: string;
  /** 会话标识：由用户 ID 与首事件 ID 派生，随重组结果确定。 */
  readonly sessionId: string;
  /** 会话内事件数。 */
  readonly eventCount: number;
  /** 首事件时间戳（毫秒）。 */
  readonly startTimeMs: number;
  /** 末事件时间戳（毫秒）。 */
  readonly endTimeMs: number;
  /** 持续时长 = 末事件时间 - 首事件时间，单事件会话为 0。 */
  readonly durationMs: number;
  /** 入口屏幕（排序后首事件的屏幕）。 */
  readonly entryScreen: string;
  /** 出口屏幕（排序后末事件的屏幕）。 */
  readonly exitScreen: string;
}
