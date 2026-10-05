import type { Action, Policy, Request, Snapshot, Window } from "./types.js";

export function ipToInt(ip: string): number {
  const parts = ip.split(".");
  if (parts.length !== 4) {
    throw new Error(`invalid IPv4 address: ${ip}`);
  }
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      throw new Error(`invalid IPv4 address: ${ip}`);
    }
    const octet = Number(part);
    if (octet > 255) {
      throw new Error(`invalid IPv4 address: ${ip}`);
    }
    value = value * 256 + octet;
  }
  return value >>> 0;
}

export function intToIp(value: number): string {
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ].join(".");
}

export interface CidrRange {
  start: number;
  end: number;
}

export function cidrRange(cidr: string): CidrRange {
  const slash = cidr.indexOf("/");
  if (slash < 0) {
    throw new Error(`invalid CIDR: ${cidr}`);
  }
  const base = ipToInt(cidr.slice(0, slash));
  const prefix = Number(cidr.slice(slash + 1));
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`invalid CIDR prefix: ${cidr}`);
  }
  const size = 2 ** (32 - prefix);
  const start = prefix === 0 ? 0 : Math.floor(base / size) * size;
  return { start, end: start + size - 1 };
}

function windowContains(window: Window, minute: number): boolean {
  if (window.start === window.end) {
    return true;
  }
  if (window.start < window.end) {
    return minute >= window.start && minute < window.end;
  }
  return minute >= window.start || minute < window.end;
}

export function policyMatches(policy: Policy, request: Request): boolean {
  if (!windowContains(policy.window, request.minute)) {
    return false;
  }
  if (!policy.tags.includes(request.tag)) {
    return false;
  }
  const ip = ipToInt(request.ip);
  return policy.cidrs.some((cidr) => {
    const range = cidrRange(cidr);
    return ip >= range.start && ip <= range.end;
  });
}

const ACTION_RANK: Record<Action, number> = {
  deny: 0,
  "require-approval": 1,
  allow: 2,
};

export function decide(policies: Policy[], request: Request): Action {
  let best: Policy | undefined;
  for (const policy of policies) {
    if (!policyMatches(policy, request)) {
      continue;
    }
    if (
      best === undefined ||
      policy.priority < best.priority ||
      (policy.priority === best.priority &&
        ACTION_RANK[policy.action] < ACTION_RANK[best.action])
    ) {
      best = policy;
    }
  }
  return best === undefined ? "deny" : best.action;
}

export function evaluate(snapshot: Snapshot, request: Request): Action {
  return decide(snapshot.policies, request);
}
