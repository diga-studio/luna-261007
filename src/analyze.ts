import type {
  CompiledJourney,
  JourneyEvent,
  JourneyResult,
  JourneyStats,
  TimeRange,
} from "./types";
import { matchesStage } from "./matcher";

export const MAX_STAGE_GAP_MS = 30 * 60 * 1000;

export interface CustomerAnalysis {
  events: JourneyEvent[];
  matchLists: Int32Array[];
  reach: Int32Array[];
  bestNext: Int32Array[];
}

export interface JourneyResultInternal extends JourneyResult {
  compiled: CompiledJourney;
  customers: Map<string | number, JourneyEvent[]>;
  entryCustomer: Map<number, string | number>;
}

function upperBound(sorted: Int32Array, value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function analyzeCustomer(
  events: JourneyEvent[],
  compiled: CompiledJourney,
): CustomerAnalysis {
  const stages = compiled.stages;
  const stageCount = stages.length;
  const matchLists: Int32Array[] = new Array(stageCount);
  for (let s = 0; s < stageCount; s++) {
    const matches: number[] = [];
    for (let i = 0; i < events.length; i++) {
      if (matchesStage(events[i], stages[s])) matches.push(i);
    }
    matchLists[s] = Int32Array.from(matches);
  }

  const reach: Int32Array[] = new Array(stageCount);
  const bestNext: Int32Array[] = new Array(stageCount);
  const lastList = matchLists[stageCount - 1];
  const reachLast = new Int32Array(lastList.length);
  reachLast.fill(stageCount);
  reach[stageCount - 1] = reachLast;
  bestNext[stageCount - 1] = new Int32Array(lastList.length).fill(-1);

  for (let s = stageCount - 2; s >= 0; s--) {
    const cur = matchLists[s];
    const nxt = matchLists[s + 1];
    const reachNxt = reach[s + 1];
    const count = stages[s + 1].count;
    const reachCur = new Int32Array(cur.length);
    const bestCur = new Int32Array(cur.length).fill(-1);
    reachCur.fill(s + 1);
    if (nxt.length >= count) {
      const deque: number[] = [];
      let head = 0;
      let hi = -1;
      for (let p = 0; p < cur.length; p++) {
        const eventIndex = cur[p];
        const limit = events[eventIndex].timestamp + MAX_STAGE_GAP_MS;
        while (hi + 1 < nxt.length && events[nxt[hi + 1]].timestamp <= limit) {
          hi++;
          while (deque.length > head && reachNxt[deque[deque.length - 1]] < reachNxt[hi]) {
            deque.pop();
          }
          deque.push(hi);
        }
        const loPos = upperBound(nxt, eventIndex) + count - 1;
        while (head < deque.length && deque[head] < loPos) head++;
        if (loPos <= hi && head < deque.length) {
          const chosen = deque[head];
          reachCur[p] = reachNxt[chosen];
          bestCur[p] = chosen;
        }
      }
    }
    reach[s] = reachCur;
    bestNext[s] = bestCur;
  }
  return { events, matchLists, reach, bestNext };
}

export function walkPath(analysis: CustomerAnalysis, entryPosition: number): number[] {
  const path = [analysis.matchLists[0][entryPosition]];
  let position = entryPosition;
  for (let s = 0; s < analysis.matchLists.length - 1; s++) {
    const nextPosition = analysis.bestNext[s][position];
    if (nextPosition < 0) break;
    path.push(analysis.matchLists[s + 1][nextPosition]);
    position = nextPosition;
  }
  return path;
}

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = sorted.length >>> 1;
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

export function analyzeJourney(
  compiled: CompiledJourney,
  events: JourneyEvent[],
  range: TimeRange,
): JourneyResult {
  if (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start >= range.end) {
    throw new Error("range must satisfy start < end with finite bounds");
  }
  const stageCount = compiled.stages.length;
  const customers = new Map<string | number, JourneyEvent[]>();
  for (const event of events) {
    const bucket = customers.get(event.customerId);
    if (bucket === undefined) customers.set(event.customerId, [event]);
    else bucket.push(event);
  }
  for (const bucket of customers.values()) {
    bucket.sort((a, b) => a.timestamp - b.timestamp || a.eventId - b.eventId);
  }

  const arrivals = new Array<number>(stageCount).fill(0);
  const durations: number[][] = [];
  for (let s = 0; s < stageCount - 1; s++) durations.push([]);
  const entryCustomer = new Map<number, string | number>();

  for (const [customerId, customerEvents] of customers) {
    const analysis = analyzeCustomer(customerEvents, compiled);
    const entries = analysis.matchLists[0];
    for (let p = 0; p < entries.length; p++) {
      const entryEvent = customerEvents[entries[p]];
      if (entryEvent.timestamp < range.start || entryEvent.timestamp >= range.end) continue;
      const path = walkPath(analysis, p);
      entryCustomer.set(entryEvent.eventId, customerId);
      for (let depth = 0; depth < path.length; depth++) {
        arrivals[depth]++;
        if (depth > 0) {
          durations[depth - 1].push(
            customerEvents[path[depth]].timestamp - customerEvents[path[depth - 1]].timestamp,
          );
        }
      }
    }
  }

  const conversionRates: (number | null)[] = [];
  const transitionMedianMs: (number | null)[] = [];
  for (let s = 0; s < stageCount - 1; s++) {
    conversionRates.push(arrivals[s] > 0 ? arrivals[s + 1] / arrivals[s] : null);
    durations[s].sort((a, b) => a - b);
    transitionMedianMs.push(median(durations[s]));
  }
  const stats: JourneyStats = { arrivals, conversionRates, transitionMedianMs };
  const result: JourneyResultInternal = {
    stats,
    entryCount: entryCustomer.size,
    compiled,
    customers,
    entryCustomer,
  };
  return result;
}
