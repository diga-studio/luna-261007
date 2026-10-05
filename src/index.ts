export type EventType = 'start' | 'call' | 'exit';

export interface ProcessEvent {
  /** observation time in milliseconds */
  t: number;
  pid: number;
  type: EventType;
  /** syscall number, present iff type === 'call' */
  call?: number;
}

export interface Detection {
  /** length of the longest suffix of the current instance's call sequence
   *  that appears as a contiguous substring in the frozen baseline */
  m: number;
  /** number of calls of the current process instance so far */
  k: number;
  /** true iff m < min(k, 8) */
  anomaly: boolean;
}

export const LEARNING_WINDOW_MS = 3_600_000;

interface ProcessInstance {
  /** full call sequence since the most recent start (learning + detection) */
  seq: number[];
  /** calls observed during the learning period only */
  learnSeq: number[];
}

interface Workload {
  learningEnd: number;
  /** all non-empty contiguous substrings of every learning-period instance
   *  sequence, encoded as comma-joined syscall numbers */
  baseline: Set<string>;
  /** longest substring length present in baseline (suffix-match upper bound) */
  maxBaselineLen: number;
  /** pid -> live instance */
  active: Map<number, ProcessInstance>;
}

const workloads = new Map<string, Workload>();

function encode(calls: number[], from: number): string {
  let s = '';
  for (let i = from; i < calls.length; i++) {
    s += (i === from ? '' : ',') + calls[i];
  }
  return s;
}

export function openWorkload(workloadId: string, t0: number): void {
  if (workloads.has(workloadId)) {
    throw new Error(`workload already exists: ${workloadId}`);
  }
  workloads.set(workloadId, {
    learningEnd: t0 + LEARNING_WINDOW_MS,
    baseline: new Set(),
    maxBaselineLen: 0,
    active: new Map(),
  });
}

export function ingest(workloadId: string, events: ProcessEvent[]): Detection[] {
  const w = workloads.get(workloadId);
  if (!w) {
    throw new Error(`unknown workload: ${workloadId}`);
  }
  const results: Detection[] = [];
  for (const ev of events) {
    if (ev.type === 'start') {
      // a start always opens a fresh, empty instance; a pid reused after an
      // exit (or a stray double-start) must not inherit the old sequence
      w.active.set(ev.pid, { seq: [], learnSeq: [] });
    } else if (ev.type === 'exit') {
      w.active.delete(ev.pid);
    } else {
      const call = ev.call;
      if (call === undefined) {
        throw new Error('call event missing syscall number');
      }
      let inst = w.active.get(ev.pid);
      if (!inst) {
        // tolerate a call without an explicit start: open an instance
        inst = { seq: [], learnSeq: [] };
        w.active.set(ev.pid, inst);
      }
      inst.seq.push(call);
      if (ev.t < w.learningEnd) {
        // learning period: extend the baseline with every new substring
        // ending at this position; the baseline only ever grows here, and
        // events are time-ordered, so it freezes once detection begins
        inst.learnSeq.push(call);
        const ls = inst.learnSeq;
        for (let i = 0; i < ls.length; i++) {
          w.baseline.add(encode(ls, i));
        }
        if (ls.length > w.maxBaselineLen) {
          w.maxBaselineLen = ls.length;
        }
      } else {
        // detection period: score against the frozen baseline; detection
        // sequences never feed back into the baseline
        const seq = inst.seq;
        const k = seq.length;
        let m = 0;
        const upper = Math.min(k, w.maxBaselineLen);
        for (let len = upper; len >= 1; len--) {
          if (w.baseline.has(encode(seq, k - len))) {
            m = len;
            break;
          }
        }
        results.push({ m, k, anomaly: m < Math.min(k, 8) });
      }
    }
  }
  return results;
}

export function resetAll(): void {
  workloads.clear();
}
