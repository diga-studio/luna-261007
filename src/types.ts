/** A named screenshot submitted as part of a run. */
export interface ScreenshotInput {
  name: string;
  /** Opaque PNG file contents. */
  png: Buffer;
}

/** Options for constructing the baseline library. */
export interface LibraryOptions {
  /** Directory holding the SQLite database and the png/ image directory. */
  dir: string;
  /** Max number of completed runs retained; oldest completed runs are cleaned beyond this. */
  maxRetainedRuns: number;
}

export interface ImageComparison {
  name: string;
  /** Percentage (0-100) of pixels whose RGB channels are exactly equal. null when no baseline existed. */
  matchRate: number | null;
  /** True when a baseline existed and matchRate >= threshold. */
  passed: boolean;
}

export interface RunProcessing {
  runId: number;
  status: 'processing';
}

export interface RunCompleted {
  runId: number;
  status: 'completed';
  /** True when every image matched (>= threshold and baseline present). */
  passed: boolean;
  /** Baseline version pinned at submission time. */
  baselineVersion: number;
  images: ImageComparison[];
}

export type RunInfo = RunProcessing | RunCompleted;

/** A screenshot stored for a run plus the baseline image actually used for comparison. */
export interface RunImageData {
  name: string;
  screenshot: Buffer;
  /** Baseline image pinned at submission time; null when the run had no baseline for this name. */
  baseline: Buffer | null;
}

export class VersionConflictError extends Error {
  constructor(
    public readonly expectedVersion: number,
    public readonly actualVersion: number,
  ) {
    super(`Baseline version conflict: expected ${expectedVersion}, actual ${actualVersion}`);
    this.name = 'VersionConflictError';
  }
}

export class RunNotFoundError extends Error {
  constructor(public readonly runId: number) {
    super(`Run not found: ${runId}`);
    this.name = 'RunNotFoundError';
  }
}
