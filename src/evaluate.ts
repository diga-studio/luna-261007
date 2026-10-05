import type { Action, Policy, Request, Snapshot, Window } from "./types.js";

const IPV4_SPACE = 0x1_0000_0000;

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
  return value;
}

export interface CidrRange {
  lo: number;
  /** exclusive */
  hi: number;
}

export function cidrToRange(cidr: string): CidrRange {
  const slash = cidr.indexOf("/");
  if (slash < 0) {
    throw new Error(`invalid CIDR: ${cidr}`);
  }
  const base = ipToInt(cidr.slice(0, slash));
  const prefixText = cidr.slice(slash + 1);
  if (!/^\d{1,2}$/.test(prefixText)) {
    throw new Error(`invalid CIDR: ${cidr}`);
  }
  const prefix = Number(prefixText);
  if (prefix > 32) {
    throw new Error(`invalid CIDR: ${cidr}`);
  }
  const size = 2 ** (32 - prefix);
  const lo = base - (base % size);
  return { lo, hi: lo + size };
}

export function windowContains(window: Window, minute: number): boolean {
  if (window.start === window.end) {
    return true;
  }
  if (window.start < window.end) {
    return minute >= window.start && minute < window.end;
  }
  return minute >= window.start || minute < window.end;
}

function policyMatches(policy: Policy, request: Request, ip: number): boolean {
  if (!windowContains(policy.window, request.minute)) {
    return false;
  }
  if (!policy.tags.includes(request.tag)) {
    return false;
  }
  return policy.cidrs.some((cidr) => {
    const range = cidrToRange(cidr);
    return ip >= range.lo && ip < range.hi;
  });
}

/** tie-break within one priority: deny > require-approval > allow */
const ACTION_RANK: Record<Action, number> = {
  deny: 0,
  "require-approval": 1,
  allow: 2,
};

export function evaluate(snapshot: Snapshot, request: Request): Action {
  if (
    !Number.isInteger(request.minute) ||
    request.minute < 0 ||
    request.minute > 1439
  ) {
    throw new Error(`invalid minute: ${request.minute}`);
  }
  const ip = ipToInt(request.ip);
  let best: Policy | undefined;
  for (const policy of snapshot.policies) {
    if (!policyMatches(policy, request, ip)) {
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

export { IPV4_SPACE };
