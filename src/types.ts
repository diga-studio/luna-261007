export type EventType = "start" | "call" | "exit";

export interface ProcessEvent {
  /** observation time in milliseconds */
  readonly t: number;
  readonly pid: number;
  readonly type: EventType;
  /** syscall number, present only when type === "call" */
  readonly call?: number;
}

export interface CallVerdict {
  /** the pid that made the call */
  readonly pid: number;
  /** the syscall number */
  readonly call: number;
  /** timestamp of the call */
  readonly t: number;
  /**
   * length of the longest suffix of the current instance's full call
   * sequence (including this call) that appeared as a contiguous
   * substring in the frozen baseline; 0 when there is no match
   */
  readonly m: number;
  /** number of calls made by the current process instance so far */
  readonly k: number;
  /** true when m < min(k, 8) */
  readonly anomalous: boolean;
}

export interface Baseline {
  openWorkload(workloadId: string, t0: number): void;
  ingest(workloadId: string, events: readonly ProcessEvent[]): CallVerdict[];
}
