import type { AccessEvent } from "./types.js";

/** 证据窗口长度：720 小时（毫秒）。 */
export const WINDOW_MS = 720 * 60 * 60 * 1000;

/** 三元组规范化字符串键。 */
export function tripleKey(t: {
  environment: string;
  resourceType: string;
  action: string;
}): string {
  return `${t.environment}${t.resourceType}${t.action}`;
}

/**
 * 从日志中提取证据三元组键集合：
 * 仅取 [now - WINDOW_MS, now) 内的成功访问，去重。
 */
export function collectEvidence(
  events: readonly AccessEvent[],
  now: number,
): Set<string> {
  const start = now - WINDOW_MS;
  const evidence = new Set<string>();
  for (const event of events) {
    if (!event.success) continue;
    if (event.timestamp < start || event.timestamp >= now) continue;
    evidence.add(tripleKey(event.triple));
  }
  return evidence;
}
