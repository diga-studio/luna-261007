/** Pipeline definition, already parsed from YAML by the caller. */
export interface PipelineDefinition {
  /** Stages execute in order; conventionally Build, Test, Deploy. */
  stages: StageDefinition[];
}

export interface StageDefinition {
  name: string;
  /** Steps execute in order within the stage. */
  steps: StepDefinition[];
}

export interface StepDefinition {
  name: string;
  /** Local executable program. */
  command: string;
  args?: string[];
  /** Optional working directory for the step. */
  cwd?: string;
  /** Optional extra environment variables. */
  env?: Record<string, string>;
}

export type RunStatus = "Queued" | "Running" | "Passed" | "Failed" | "Canceled";

export const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set([
  "Passed",
  "Failed",
  "Canceled",
]);

export interface RunRecord {
  id: string;
  status: RunStatus;
  /** Monotonic submission sequence; waiting runs start in this order. */
  seq: number;
  definition: PipelineDefinition;
  /** Directory (chosen by the caller) where logs for this run are stored. */
  logDir: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Index of the currently executing stage/step while Running. */
  currentStage: number | null;
  currentStep: number | null;
  /** Short human-readable reason for Failed/Canceled, when available. */
  detail: string | null;
}

export interface StepLogRef {
  stageIndex: number;
  stepIndex: number;
  stageName: string;
  stepName: string;
  stdoutPath: string;
  stderrPath: string;
}

export interface RunLogs {
  runId: string;
  steps: StepLogRef[];
}

export interface CancelResult {
  /** True when the cancel request was accepted (run was Queued or Running). */
  accepted: boolean;
  /** Status of the run at the moment the request was evaluated. */
  status: RunStatus;
}

export interface SubmitOptions {
  /** Caller-chosen directory for this run's logs. Must be a local path. */
  logDir: string;
}

export interface ExecutorOptions {
  /** SQLite database file path, or ":memory:". */
  dbPath: string;
  /** Max concurrently executing runs. Defaults to 1. */
  concurrency?: number;
}
