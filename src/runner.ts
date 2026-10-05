import { once } from "node:events";
import { LogStore } from "./logStore";
import { spawnStep, SpawnedStep } from "./processTree";
import { RunStore } from "./store";
import { RunRecord } from "./types";

export type RunOutcome = "Passed" | "Failed" | "Canceled";

/**
 * Executes a single run end to end: stages and steps sequentially,
 * enforcing cancellation and process-tree cleanup between steps.
 */
export class Runner {
  private cancelRequested = false;
  private current: SpawnedStep | null = null;

  constructor(
    private readonly store: RunStore,
    private readonly run: RunRecord,
    private readonly logs: LogStore
  ) {}

  /** True once cancellation has been requested for this run. */
  isCancelRequested(): boolean {
    return this.cancelRequested;
  }

  /**
   * Request cancellation. Idempotent: repeated calls never restart
   * cleanup work.
   */
  requestCancel(): void {
    if (this.cancelRequested) return;
    this.cancelRequested = true;
    // Stop the in-flight step, if any. execute() awaits killTree() itself;
    // this call only starts termination early.
    void this.current?.killTree();
  }

  /**
   * Execute the run to a terminal state.
   * Resolves only after every spawned process has stopped and all logs
   * are flushed to disk; the terminal status is written last.
   */
  async execute(): Promise<RunOutcome> {
    const stages = this.run.definition.stages;
    for (let stageIndex = 0; stageIndex < stages.length; stageIndex++) {
      const stage = stages[stageIndex];
      for (let stepIndex = 0; stepIndex < stage.steps.length; stepIndex++) {
        if (this.cancelRequested) {
          return this.finish("Canceled", "canceled before starting next step");
        }
        const step = stage.steps[stepIndex];
        this.store.updateProgress(this.run.id, stageIndex, stepIndex);

        const writer = this.logs.openStep(stageIndex, stepIndex, stage.name, step.name);
        const spawned = spawnStep(step);
        this.current = spawned;

        // "close" (not "end"): on spawn failure the pipes are destroyed
        // without an "end" event.
        const swallow = () => undefined;
        const stdoutDone = spawned.stdout
          ? once(spawned.stdout, "close").then(swallow, swallow)
          : Promise.resolve();
        const stderrDone = spawned.stderr
          ? once(spawned.stderr, "close").then(swallow, swallow)
          : Promise.resolve();
        spawned.stdout?.on("data", (chunk: Buffer) => writer.writeStdout(chunk));
        spawned.stderr?.on("data", (chunk: Buffer) => writer.writeStderr(chunk));

        const exit = await spawned.exit;
        // The main program is gone; stop any descendants before moving on.
        await spawned.killTree();
        // Pipe EOF only arrives once every process holding the write end
        // (including descendants) has exited, so termination-time output
        // is captured too.
        await Promise.all([stdoutDone, stderrDone]);
        await writer.finalize();
        this.current = null;

        // Cancellation wins over any exit notification, success or failure.
        if (this.cancelRequested) {
          return this.finish("Canceled", "canceled");
        }
        if (exit.spawnError) {
          return this.finish("Failed", `step "${step.name}" failed to start: ${exit.spawnError.message}`);
        }
        if (exit.code !== 0) {
          return this.finish("Failed", `step "${step.name}" exited with code ${exit.code}`);
        }
      }
    }
    return this.finish("Passed", null);
  }

  private finish(outcome: RunOutcome, detail: string | null): RunOutcome {
    // Logs (and their manifest) must be fully saved before the terminal
    // state becomes visible.
    this.logs.writeManifest();
    this.store.updateStatus(this.run.id, ["Running"], outcome, {
      finishedAt: new Date().toISOString(),
      detail,
    });
    return outcome;
  }
}
