import { cidrRange, evaluate, intToIp } from "./evaluate.js";
import type { CompareResult, Evidence, Snapshot, Tag } from "./types.js";

const TAGS: Tag[] = ["low", "medium", "high"];
const IP_SPACE = 2 ** 32;
const MINUTE_SPACE = 1440;

function ipRepresentatives(snapshots: Snapshot[]): number[] {
  const boundaries = new Set<number>([0, IP_SPACE]);
  for (const snapshot of snapshots) {
    for (const policy of snapshot.policies) {
      for (const cidr of policy.cidrs) {
        const range = cidrRange(cidr);
        boundaries.add(range.start);
        boundaries.add(range.end + 1);
      }
    }
  }
  const sorted = [...boundaries].sort((a, b) => a - b);
  const representatives: number[] = [];
  for (let i = 0; i + 1 < sorted.length; i += 1) {
    if (sorted[i] < sorted[i + 1]) {
      representatives.push(sorted[i]);
    }
  }
  return representatives;
}

function minuteRepresentatives(snapshots: Snapshot[]): number[] {
  const boundaries = new Set<number>([0, MINUTE_SPACE]);
  for (const snapshot of snapshots) {
    for (const policy of snapshot.policies) {
      boundaries.add(policy.window.start);
      boundaries.add(policy.window.end);
    }
  }
  const sorted = [...boundaries].sort((a, b) => a - b);
  const representatives: number[] = [];
  for (let i = 0; i + 1 < sorted.length; i += 1) {
    if (sorted[i] < sorted[i + 1]) {
      representatives.push(sorted[i]);
    }
  }
  return representatives;
}

export function compare(left: Snapshot, right: Snapshot): CompareResult {
  const ips = ipRepresentatives([left, right]);
  const minutes = minuteRepresentatives([left, right]);
  const evidence: Evidence[] = [];
  for (const ip of ips) {
    for (const minute of minutes) {
      for (const tag of TAGS) {
        const request = { minute, ip: intToIp(ip), tag };
        const leftAction = evaluate(left, request);
        const rightAction = evaluate(right, request);
        if (leftAction !== rightAction) {
          evidence.push({ request, left: leftAction, right: rightAction });
        }
      }
    }
  }
  return { equivalent: evidence.length === 0, evidence };
}
