import type {
  CompiledJourney,
  CompiledStage,
  JourneyAnalysis,
  JourneyEvent,
  JourneyRange,
  StageStats,
} from "./types";

/** Maximum completion-time gap between consecutive stages: 30 minutes, inclusive. */
const WINDOW_MS = 30 * 60 * 1000;
const NONE = 0xffffffff;

type Matcher = (ev: JourneyEvent) => boolean;

function buildMatcher(stage: CompiledStage): Matcher {
  const conditions = Object.entries(stage.properties);
  const eventType = stage.eventType;
  return (ev: JourneyEvent): boolean => {
    if (ev.eventType !== eventType) return false;
    if (conditions.length === 0) return true;
    const props = ev.properties;
    if (props === undefined) return false;
    for (const [key, value] of conditions) {
      if (props[key] !== value) return false;
    }
    return true;
  };
}

function medianOf(values: number[]): number {
  values.sort((a, b) => a - b);
  const mid = values.length >> 1;
  if (values.length % 2 === 1) return values[mid]!;
  return (values[mid - 1]! + values[mid]!) / 2;
}

/**
 * Runs ordered journey attribution.
 *
 * @param compiled compiled journey definition (see compileJourney)
 * @param groups events grouped by customer; each inner array holds one
 *   customer's events sorted by (timestamp, eventId) ascending
 * @param range half-open entry time range [startInclusive, endExclusive);
 *   only the stage-1 (entry) event must fall inside it
 */
export function analyzeJourney(
  compiled: CompiledJourney,
  groups: ReadonlyArray<ReadonlyArray<JourneyEvent>>,
  range: JourneyRange,
): JourneyAnalysis {
  if (
    !Number.isFinite(range.startInclusive) ||
    !Number.isFinite(range.endExclusive) ||
    range.startInclusive > range.endExclusive
  ) {
    throw new Error("invalid range: require finite startInclusive <= endExclusive");
  }

  const stages = compiled.stages;
  const stageCount = stages.length;
  const matchers = stages.map(buildMatcher);

  const arrivals = new Array<number>(stageCount).fill(0);
  const transitions: number[][] = [];
  for (let k = 0; k < stageCount; k++) transitions.push([]);
  const paths = new Map<number, number[]>();

  for (const events of groups) {
    const n = events.length;
    if (n === 0) continue;

    // Bitmask of matched stages per event (stageCount <= 20 fits in 32 bits).
    const masks = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      const ev = events[i]!;
      let mask = 0;
      for (let k = 0; k < stageCount; k++) {
        if (matchers[k]!(ev)) mask |= 1 << k;
      }
      masks[i] = mask;
    }

    // Backward dynamic programming. reach[i] (for events matching stage k)
    // is the maximum number of stages reachable when stage k completes at
    // event i. choice[k][i] is the selected completion event index of
    // stage k+1: among candidates achieving the max reach, the smallest
    // index (i.e. lexicographically earliest by (timestamp, eventId)).
    let reachNext = new Uint8Array(n);
    const lastBit = 1 << (stageCount - 1);
    for (let i = 0; i < n; i++) {
      if (masks[i]! & lastBit) reachNext[i] = stageCount;
    }

    const choiceArrays: Uint32Array[] = new Array<Uint32Array>(stageCount - 1);
    for (let k = stageCount - 2; k >= 0; k--) {
      const required = stages[k + 1]!.count;
      const nextBit = 1 << (k + 1);
      const curBit = 1 << k;
      const reachCur = new Uint8Array(n);
      const choice = new Uint32Array(n).fill(NONE);

      // Monotonic deque of candidate completion events for stage k+1.
      // Layout left->right = older->newer = larger index -> smaller index.
      // Keys (reachNext, then smaller index wins) decrease left->right,
      // so the leftmost element is always the best valid candidate.
      const deque = new Uint32Array(n);
      let head = 0; // index of leftmost element
      let size = 0;
      // The up to (required - 1) smallest-index seen matches of stage k+1
      // (ascending event index); these are not yet completion candidates.
      const recent: number[] = [];

      for (let i = n - 1; i >= 0; i--) {
        // Event j = i+1 enters the set of events after i.
        const j = i + 1;
        if (j < n && masks[j]! & nextBit) {
          if (required === 1) {
            pushCandidate(j);
          } else if (recent.length < required - 1) {
            recent.unshift(j);
          } else {
            // The previous (required-1)-th match becomes the required-th.
            const candidate = recent[recent.length - 1]!;
            recent.pop();
            recent.unshift(j);
            pushCandidate(candidate);
          }
        }
        // Drop candidates outside the 30-minute window (largest indices first).
        const limit = events[i]!.timestamp + WINDOW_MS;
        while (size > 0) {
          const left = deque[head]!;
          if (events[left]!.timestamp > limit) {
            head = (head + 1) % n;
            size--;
          } else {
            break;
          }
        }
        // Best path query for completions of stage k at event i.
        if (masks[i]! & curBit) {
          if (size > 0) {
            const best = deque[head]!;
            reachCur[i] = reachNext[best]!;
            choice[i] = best;
          } else {
            reachCur[i] = k + 1; // reaches exactly stage k+1 (1-based)
          }
        }
      }

      function pushCandidate(x: number): void {
        // x has a smaller index than every element currently in the deque,
        // so it wins all reach ties. Pop dominated elements from the right.
        const reachX = reachNext[x]!;
        while (size > 0) {
          const rightPos = (head + size - 1) % n;
          if (reachNext[deque[rightPos]!]! <= reachX) {
            size--;
          } else {
            break;
          }
        }
        const tail = (head + size) % n;
        deque[tail] = x;
        size++;
      }

      choiceArrays[k] = choice;
      reachNext = reachCur;
    }

    // One attempt per stage-1 match inside the entry range.
    for (let i = 0; i < n; i++) {
      if (!(masks[i]! & 1)) continue;
      const t = events[i]!.timestamp;
      if (t < range.startInclusive || t >= range.endExclusive) continue;

      const pathIndices = [i];
      let cur = i;
      for (let k = 0; k < stageCount - 1; k++) {
        const nxt = choiceArrays[k]![cur]!;
        if (nxt === NONE) break;
        pathIndices.push(nxt);
        cur = nxt;
      }

      const reached = pathIndices.length;
      for (let k = 0; k < reached; k++) arrivals[k]!++;
      for (let k = 1; k < reached; k++) {
        transitions[k]!.push(
          events[pathIndices[k]!]!.timestamp - events[pathIndices[k - 1]!]!.timestamp,
        );
      }
      paths.set(
        events[i]!.eventId,
        pathIndices.map((idx) => events[idx]!.eventId),
      );
    }
  }

  const stageStats: StageStats[] = [];
  for (let k = 0; k < stageCount; k++) {
    const previous = k === 0 ? 0 : arrivals[k - 1]!;
    const durations = transitions[k]!;
    stageStats.push({
      stage: k + 1,
      arrivals: arrivals[k]!,
      conversionFromPrevious:
        k === 0 || previous === 0 ? null : arrivals[k]! / previous,
      medianTransitionMs:
        k === 0 || durations.length === 0 ? null : medianOf(durations),
    });
  }

  return {
    compiled,
    range,
    totalAttempts: paths.size,
    stages: stageStats,
    paths,
  };
}
