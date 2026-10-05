/** Per-file lifecycle states inside a purge job. */
export type EntryState =
  | "pending" // accepted, not yet processed by purge
  | "purged" // content moved into module retention
  | "restored" // content restored to the original path
  | "conflict" // restore blocked: original path occupied
  | "reclaimed" // retention expired, content permanently deleted
  | "missing"; // source file did not exist when purge ran

export interface JobEntryView {
  /** Original absolute path supplied by the caller. */
  path: string;
  state: EntryState;
}

export interface JobView {
  jobId: string;
  /** Epoch ms when the job was first received; retention anchor. */
  receivedAt: number;
  /** Epoch ms after which undo is rejected and reclaim may run. */
  deadline: number;
  entries: JobEntryView[];
}

export interface PurgeWaveOptions {
  /** Directory owned by the module: SQLite db + retained blobs live here. */
  storageDir: string;
  /** Clock override (epoch ms). Defaults to Date.now. */
  now?: () => number;
  /**
   * Test-only fault injection hook. Invoked after every individual file
   * mutation and every individual record commit. Throwing here simulates a
   * process crash at that exact point.
   */
  faultHook?: (event: FaultEvent) => void;
}

export interface FaultEvent {
  /** Which high-level operation is running. */
  op: "purge" | "undo" | "reclaim" | "recover";
  /** "file" = after a filesystem mutation, "record" = after a db commit. */
  kind: "file" | "record";
  jobId: string;
  path?: string;
}

export const MAX_PATHS_PER_JOB = 5000;
export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
