export type Action = "allow" | "deny" | "require-approval";

export type Tag = "low" | "medium" | "high";

export const ALL_TAGS: readonly Tag[] = ["low", "medium", "high"];

export interface Window {
  /** inclusive, UTC minute of day, 0..1439 */
  start: number;
  /** exclusive, UTC minute of day, 0..1439; start > end wraps midnight; start === end means all day */
  end: number;
}

export interface Policy {
  /** 1..100, smaller wins */
  priority: number;
  action: Action;
  /** IPv4 CIDRs, may repeat or contain each other */
  cidrs: string[];
  window: Window;
  /** non-empty subset of tags */
  tags: Tag[];
}

export interface Snapshot {
  policies: Policy[];
}

export interface Request {
  minute: number;
  ip: string;
  tag: Tag;
}

export interface CompareResult {
  equal: boolean;
  /** witness requests: evaluate(left, w) !== evaluate(right, w) */
  evidence: Request[];
}
