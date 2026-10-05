export type Action = "allow" | "deny" | "require-approval";

export type Tag = "low" | "medium" | "high";

export interface Window {
  start: number;
  end: number;
}

export interface Policy {
  priority: number;
  action: Action;
  cidrs: string[];
  window: Window;
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

export interface Evidence {
  request: Request;
  left: Action;
  right: Action;
}

export interface CompareResult {
  equivalent: boolean;
  evidence: Evidence[];
}
