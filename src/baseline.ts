import type { Baseline, CallVerdict, ProcessEvent } from "./types";

const LEARN_WINDOW_MS = 3_600_000;
const ANOMALY_THRESHOLD = 8;

interface ProcessInstance {
  /** syscall numbers since the most recent "start" */
  seq: number[];
}

interface WorkloadState {
  /** learning window is [t0, learnEnd); calls with t >= learnEnd are detection */
  learnEnd: number;
  /**
   * every non-empty contiguous substring of every process instance
   * sequence observed during the learning period. Encoded by joining
   * syscall numbers with "," (unambiguous for non-negative integers).
   * Only appended to while t < learnEnd, so it is permanently frozen
   * once the workload clock passes the boundary.
   */
  substrings: Set<string>;
  /** current instance per pid; deleted on "exit" */
  instances: Map<number, ProcessInstance>;
}

function encode(calls: readonly number[], from: number): string {
  let out = "";
  for (let i = from; i < calls.length; i++) {
    out += calls[i]!.toString(36) + ",";
  }
  return out;
}

class Workload implements WorkloadState {
  readonly learnEnd: number;
  readonly substrings = new Set<string>();
  readonly instances = new Map<number, ProcessInstance>();

  constructor(t0: number) {
    this.learnEnd = t0 + LEARN_WINDOW_MS;
  }

  private instanceFor(pid: number): ProcessInstance {
    let inst = this.instances.get(pid);
    if (inst === undefined) {
      inst = { seq: [] };
      this.instances.set(pid, inst);
    }
    return inst;
  }

  ingest(events: readonly ProcessEvent[], verdicts: CallVerdict[]): void {
    for (const ev of events) {
      switch (ev.type) {
        case "start":
          // a start always begins a fresh, empty instance; a reused pid
          // never inherits the previous instance's sequence
          this.instances.set(ev.pid, { seq: [] });
          break;
        case "exit":
          this.instances.delete(ev.pid);
          break;
        case "call":
          this.onCall(ev, verdicts);
          break;
      }
    }
  }

  private onCall(ev: ProcessEvent, verdicts: CallVerdict[]): void {
    const call = ev.call;
    if (call === undefined) {
      throw new Error(`call event without syscall number (pid=${ev.pid}, t=${ev.t})`);
    }
    const inst = this.instanceFor(ev.pid);
    inst.seq.push(call);
    const k = inst.seq.length;
    if (ev.t < this.learnEnd) {
      // learning: every new suffix is a new contiguous substring ending
      // at this call; older substrings are already recorded
      for (let from = 0; from < k; from++) {
        this.substrings.add(encode(inst.seq, from));
      }
      return;
    }
    // detection: longest suffix of the full instance sequence that is
    // present in the frozen baseline
    let m = 0;
    for (let len = k; len >= 1; len--) {
      if (this.substrings.has(encode(inst.seq, k - len))) {
        m = len;
        break;
      }
    }
    verdicts.push({
      pid: ev.pid,
      call,
      t: ev.t,
      m,
      k,
      anomalous: m < Math.min(k, ANOMALY_THRESHOLD),
    });
  }
}

export function createBaseline(): Baseline {
  const workloads = new Map<string, Workload>();
  return {
    openWorkload(workloadId: string, t0: number): void {
      if (workloads.has(workloadId)) {
        throw new Error(`workload already open: ${workloadId}`);
      }
      workloads.set(workloadId, new Workload(t0));
    },
    ingest(workloadId: string, events: readonly ProcessEvent[]): CallVerdict[] {
      const workload = workloads.get(workloadId);
      if (workload === undefined) {
        throw new Error(`unknown workload: ${workloadId}`);
      }
      const verdicts: CallVerdict[] = [];
      workload.ingest(events, verdicts);
      return verdicts;
    },
  };
}
