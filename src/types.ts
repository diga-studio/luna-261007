import { Buffer } from 'node:buffer';

/** A single named screenshot submitted as part of a run. */
export interface ScreenshotInput {
  name: string;
  png: Buffer;
}

export type RunStatus = 'processing' | 'completed';

/** Per-screenshot comparison outcome, present once a run is completed. */
export interface ImageComparison {
  name: string;
  /** RGB-exact pixel match percentage (0-100). Null when no baseline existed. */
  matchRate: number | null;
  baselineExists: boolean;
  passed: boolean;
}

/** Snapshot of a run as returned by queries. */
export interface RunInfo {
  id: string;
  status: RunStatus;
  /** Baseline version pinned at submission time. */
  baselineVersion: number;
  /** Overall verdict; only present when status is 'completed'. */
  passed?: boolean;
  /** Per-image results; only present when status is 'completed'. */
  images?: ImageComparison[];
}

/** The screenshots of a run plus the baseline images actually compared against. */
export interface RunImageData {
  name: string;
  screenshot: Buffer;
  /** The pinned baseline image used for comparison; null if none existed. */
  baseline: Buffer | null;
}

export interface BaselineInfo {
  version: number;
  names: string[];
}

export type ApproveError =
  | 'run_not_found'
  | 'run_not_completed'
  | 'unknown_names'
  | 'version_conflict';

export interface ApproveResult {
  ok: boolean;
  /** Baseline version after a successful approval. */
  baselineVersion?: number;
  error?: ApproveError;
}

export interface LibraryOptions {
  /** Directory holding the SQLite database and the PNG image store. */
  dir: string;
  /** Maximum number of completed runs retained. Defaults to 10. */
  maxRetainedRuns?: number;
}
