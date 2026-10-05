import { randomUUID } from "node:crypto";
import { LogStore } from "./logStore";
import { Runner } from "./runner";
import { RunStore } from "./store";
import {
  CancelResult,
  ExecutorOptions,
  PipelineDefinition,
  RunLogs,
  RunRecord,
  SubmitOptions,
  TERMINAL_STATUSES,
} from "./types";

/**
 * Public entry point: submit runs, request cancellation, inspect runs and logs.
 * Waiting runs start in submission order; at most `concurrency` execute at
 * once, and an execution slot is held until the run's processes have all
 * stopped and its logs are fully saved.
 */
export class PipelineExecutor {
  private readonly store: RunStore;
  private readonly concurrency: number;
  private readonly active = new Map<string, { runner: Runner; logs: LogStore }>();
  private runningCount = 0;
  private scheduling = false;
  private idleWaiters: Array<() => void> = [];

  constructor(options: ExecutorOptions) {
    this.store = new RunStore(options.dbPath);
    this.concurrency = Math.max(1, options.concurrency ?? 1);
  }

  submit(definition: PipelineDefinition, opts: SubmitOptions): RunRecord {
    if (!definition || !Array.isArray(definition.stages)) {
      throw new Error("invalid pipeline definition: stages must be an array");
    }
    const record: RunRecord = {
      id: randomUUID(),
      seq: this.store.nextSeq(),
      status: "Queued",
      definition,
      logDir: opts.logDir,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      currentStage: null,
      currentStep: null,
      detail: null,
    };
    this.store.insert(record);
    this.schedule();
    return record;
  }

  requestCancel(runId: string): CancelResult {
    const record = this.store.get(runId);
    if (!record) throw new Error(`run not found: ${runId}`);
    if (TERMINAL_STATUSES.has(record.status)) {
      return { accepted: false, status: record.status };
    }
    if (record.status === "Queued") {
      const won = this.store.updateStatus(runId, ["Queued"], "Canceled", {
        finishedAt: new Date().toISOString(),
        detail: "canceled while queued",
      });
      if (won) return { accepted: true, status: "Canceled" };
      // Lost the race with the scheduler: the run just started.
    }
    const entry = this.active.get(runId);
    if (entry) {
      entry.runner.requestCancel();
      return { accepted: true, status: "Running" };
    }
    // The run completed between the first read and now.
    const latest = this.store.get(runId);
    if (latest && TERMINAL_STATUSES.has(latest.status)) {
      return { accepted: false, status: latest.status };
    }
    return { accepted: true, status: latest?.status ?? record.status };
  }

  getRun(runId: string): RunRecord | null {
    return this.store.get(runId);
  }

  getLogs(runId: string): RunLogs | null {
    const record = this.store.get(runId);
    if (!record) return null;
    const entry = this.active.get(runId);
    const steps = entry ? entry.logs.listSteps() : LogStore.readManifest(record.logDir);
    return { runId, steps };
  }

  /** Wait until all queued/running runs reach a terminal state. */
  async drain(): Promise<void> {
    while (this.runningCount > 0 || this.store.listQueued().length > 0) {
      await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
    }
  }

  close(): void {
    this.store.close();
  }

  private schedule(): void {
    if (this.scheduling) return;
    this.scheduling = true;
    try {
      while (this.runningCount < this.concurrency) {
        const queued = this.store.listQueued();
        if (queued.length === 0) break;
        const next = queued[0];
        // Atomic claim: canceled queued runs are skipped.
        const claimed = this.store.updateStatus(next.id, ["Queued"], "Running", {
          startedAt: new Date().toISOString(),
        });
        if (!claimed) continue;
        const run = this.store.get(next.id);
        if (!run) continue;
        this.runningCount++;
        const logs = new LogStore(run.logDir);
        const runner = new Runner(this.store, run, logs);
        this.active.set(run.id, { runner, logs });
        runner
          .execute()
          .catch((err: unknown) => {
            // Defensive: never leave a run stuck in Running.
            this.store.updateStatus(run.id, ["Running"], "Failed", {
              finishedAt: new Date().toISOString(),
              detail: `internal error: ${err instanceof Error ? err.message : String(err)}`,
            });
          })
          .finally(() => {
            this.active.delete(run.id);
            this.runningCount--;
            this.schedule();
            this.checkIdle();
          });
      }
    } finally {
      this.scheduling = false;
    }
  }

  private checkIdle(): void {
    if (this.runningCount === 0 && this.store.listQueued().length === 0) {
      const waiters = this.idleWaiters.splice(0);
      for (const waiter of waiters) waiter();
    }
  }
}
