import { evaluate, cidrToRange, ipToInt, IPV4_SPACE } from "./evaluate.js";
import {
  ALL_TAGS,
  type CompareResult,
  type Request,
  type Snapshot,
  type Window,
} from "./types.js";

function intToIp(value: number): string {
  return [
    Math.floor(value / 2 ** 24) % 256,
    Math.floor(value / 2 ** 16) % 256,
    Math.floor(value / 2 ** 8) % 256,
    value % 256,
  ].join(".");
}

function windowIntervals(window: Window): Array<[number, number]> {
  if (window.start === window.end) {
    return [[0, 1440]];
  }
  if (window.start < window.end) {
    return [[window.start, window.end]];
  }
  return [
    [window.start, 1440],
    [0, window.end],
  ];
}

/** sorted unique boundary points -> representative of each elementary cell */
function representatives(boundaries: number[]): number[] {
  const sorted = [...new Set(boundaries)].sort((a, b) => a - b);
  const reps: number[] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const lo = sorted[i]!;
    const hi = sorted[i + 1]!;
    if (lo < hi) {
      reps.push(lo);
    }
  }
  return reps;
}

function ipRepresentatives(snapshots: Snapshot[]): number[] {
  const boundaries = [0, IPV4_SPACE];
  for (const snapshot of snapshots) {
    for (const policy of snapshot.policies) {
      for (const cidr of policy.cidrs) {
        const range = cidrToRange(cidr);
        boundaries.push(Math.max(range.lo, 0), Math.min(range.hi, IPV4_SPACE));
      }
    }
  }
  return representatives(boundaries);
}

function minuteRepresentatives(snapshots: Snapshot[]): number[] {
  const boundaries = [0, 1440];
  for (const snapshot of snapshots) {
    for (const policy of snapshot.policies) {
      for (const [lo, hi] of windowIntervals(policy.window)) {
        boundaries.push(lo, hi);
      }
    }
  }
  return representatives(boundaries);
}

export function compare(left: Snapshot, right: Snapshot): CompareResult {
  const ips = ipRepresentatives([left, right]);
  const minutes = minuteRepresentatives([left, right]);
  const evidence: Request[] = [];
  for (const ip of ips) {
    for (const minute of minutes) {
      for (const tag of ALL_TAGS) {
        const request: Request = { minute, ip: intToIp(ip), tag };
        if (evaluate(left, request) !== evaluate(right, request)) {
          evidence.push(request);
        }
      }
    }
  }
  return { equal: evidence.length === 0, evidence };
}

export { intToIp, ipToInt };
