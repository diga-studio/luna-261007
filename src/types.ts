/** 查看授权。字段为 null 表示该项不限。 */
export interface Grant {
  /** 毫秒时间戳，当前时间达到它即失效；null 表示不限。 */
  expiresAt: number | null;
  /** 最大查看次数；null 表示不限。 */
  maxViews: number | null;
}

/** 内容源：按 documentId 打开异步字节流，产生明文字节，每块不超过 64 KiB。 */
export interface ContentSource {
  open(documentId: string): AsyncIterable<Uint8Array>;
}

/** 可注入时钟，返回当前毫秒时间戳。 */
export type Clock = () => number;

export const MAX_CHUNK_BYTES = 64 * 1024;
export const TOKEN_TTL_MS = 60_000;
