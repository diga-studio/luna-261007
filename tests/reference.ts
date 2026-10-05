import { Detection, LEARNING_WINDOW_MS, ProcessEvent } from '../src/index';

interface RefInstance {
  seq: number[];
  learnSeq: number[];
}

interface RefWorkload {
  learningEnd: number;
  /** learning-period call sequence of every instance (live or exited) */
  learnSequences: number[][];
  active: Map<number, RefInstance>;
}

/**
 * Naive reference: keeps whole learning sequences and, for every detection
 * call, enumerates all contiguous substrings of all learning sequences by
 * brute force to find the longest matching suffix. Deliberately shares no
 * logic with the implementation under test.
 */
export class ReferenceBaseline {
  private workloads = new Map<string, RefWorkload>();

  openWorkload(workloadId: string, t0: number): void {
    if (this.workloads.has(workloadId)) {
      throw new Error(`workload already exists: ${workloadId}`);
    }
    this.workloads.set(workloadId, {
      learningEnd: t0 + LEARNING_WINDOW_MS,
      learnSequences: [],
      active: new Map(),
    });
  }

  ingest(workloadId: string, events: ProcessEvent[]): Detection[] {
    const w = this.workloads.get(workloadId);
    if (!w) {
      throw new Error(`unknown workload: ${workloadId}`);
    }
    const results: Detection[] = [];
    for (const ev of events) {
      if (ev.type === 'start') {
        const inst: RefInstance = { seq: [], learnSeq: [] };
        w.active.set(ev.pid, inst);
        w.learnSequences.push(inst.learnSeq);
      } else if (ev.type === 'exit') {
        w.active.delete(ev.pid);
      } else {
        let inst = w.active.get(ev.pid);
        if (!inst) {
          inst = { seq: [], learnSeq: [] };
          w.active.set(ev.pid, inst);
          w.learnSequences.push(inst.learnSeq);
        }
        inst.seq.push(ev.call as number);
        if (ev.t < w.learningEnd) {
          inst.learnSeq.push(ev.call as number);
        } else {
          results.push(this.score(w, inst.seq));
        }
      }
    }
    return results;
  }

  private score(w: RefWorkload, seq: number[]): Detection {
    const k = seq.length;
    let m = 0;
    for (let len = 1; len <= k; len++) {
      const suffix = seq.slice(k - len);
      if (appearsAsSubstring(w.learnSequences, suffix)) {
        m = len;
      }
    }
    return { m, k, anomaly: m < Math.min(k, 8) };
  }
}

/** brute-force: does `sub` occur as a contiguous substring of any sequence? */
function appearsAsSubstring(sequences: number[][], sub: number[]): boolean {
  for (const s of sequences) {
    outer: for (let i = 0; i + sub.length <= s.length; i++) {
      for (let j = 0; j < sub.length; j++) {
        if (s[i + j] !== sub[j]) {
          continue outer;
        }
      }
      return true;
    }
  }
  return false;
}
