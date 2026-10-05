import type { CallVerdict, ProcessEvent } from "../src/types";

const LEARN_WINDOW_MS = 3_600_000;

interface RefInstance {
  /** calls with t < learnEnd (the learning-period prefix) */
  learnSeq: number[];
  /** all calls of the current instance */
  seq: number[];
}

interface RefWorkload {
  learnEnd: number;
  /** learning-period sequences of every instance, past and present */
  learned: number[][];
  instances: Map<number, RefInstance>;
}

/**
 * Naive reference implementation. Recomputes the full substring set by
 * brute force on every detection call; only suitable for small inputs.
 */
export class ReferenceBaseline {
  private readonly workloads = new Map<string, RefWorkload>();

  openWorkload(workloadId: string, t0: number): void {
    this.workloads.set(workloadId, {
      learnEnd: t0 + LEARN_WINDOW_MS,
      learned: [],
      instances: new Map(),
    });
  }

  ingest(workloadId: string, events: readonly ProcessEvent[]): CallVerdict[] {
    const w = this.workloads.get(workloadId);
    if (w === undefined) throw new Error(`unknown workload: ${workloadId}`);
    const verdicts: CallVerdict[] = [];
    for (const ev of events) {
      if (ev.type === "start") {
        const inst: RefInstance = { learnSeq: [], seq: [] };
        w.instances.set(ev.pid, inst);
        w.learned.push(inst.learnSeq);
      } else if (ev.type === "exit") {
        w.instances.delete(ev.pid);
      } else {
        const inst = w.instances.get(ev.pid);
        if (inst === undefined || ev.call === undefined) continue;
        inst.seq.push(ev.call);
        const k = inst.seq.length;
        if (ev.t < w.learnEnd) {
          inst.learnSeq.push(ev.call);
          continue;
        }
        const m = longestSuffixInBaseline(inst.seq, w.learned);
        verdicts.push({
          pid: ev.pid,
          call: ev.call,
          t: ev.t,
          m,
          k,
          anomalous: m < Math.min(k, 8),
        });
      }
    }
    return verdicts;
  }
}

function isSubstring(needle: readonly number[], from: number, haystack: readonly number[]): boolean {
  const len = needle.length - from;
  if (len > haystack.length) return false;
  outer: for (let i = 0; i + len <= haystack.length; i++) {
    for (let j = 0; j < len; j++) {
      if (haystack[i + j] !== needle[from + j]) continue outer;
    }
    return true;
  }
  return false;
}

function longestSuffixInBaseline(seq: readonly number[], learned: readonly number[][]): number {
  for (let len = seq.length; len >= 1; len--) {
    const from = seq.length - len;
    for (const hay of learned) {
      if (isSubstring(seq, from, hay)) return len;
    }
  }
  return 0;
}
