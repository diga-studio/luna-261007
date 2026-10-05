import type { RunStore } from './db';
import type { LogStore } from './log-store';
import { killProcessTree, spawnStep } from './process-killer';
import { TERMINAL_STATUSES, type PipelineDefinition } from './types';

/** 单次运行的执行体：取消标记与清理均幂等。 */
export class RunExecution {
  private cancelRequested = false;
  private currentPid: number | null = null;
  private currentKill: Promise<void> | null = null;

  constructor(
    readonly runId: string,
    readonly definition: PipelineDefinition,
    private readonly store: RunStore,
    private readonly logs: LogStore,
  ) {}

  /** 申请取消：终态不受理；重复取消幂等，不重复清理。 */
  requestCancel(): boolean {
    const record = this.store.get(this.runId);
    if (!record || TERMINAL_STATUSES.has(record.status)) return false;
    if (this.cancelRequested) return true;
    this.cancelRequested = true;
    this.killCurrent();
    return true;
  }

  get isCancelRequested(): boolean {
    return this.cancelRequested;
  }

  private killCurrent(): void {
    if (this.currentPid !== null && !this.currentKill) {
      this.currentKill = killProcessTree(this.currentPid);
    }
  }

  /** 执行到终态；resolve 时全部进程已停止、日志已保存完毕。 */
  async run(): Promise<void> {
    // Queued -> Running；排队期间已被取消的（已是终态）直接返回。
    if (!this.store.transition(this.runId, ['Queued'], 'Running', null, Date.now())) return;

    let failedReason: string | null = null;

    outer: for (let stageIndex = 0; stageIndex < this.definition.stages.length; stageIndex++) {
      const stage = this.definition.stages[stageIndex];
      for (let stepIndex = 0; stepIndex < stage.steps.length; stepIndex++) {
        if (this.cancelRequested) break outer;
        const step = stage.steps[stepIndex];
        // 注意：从取消检查到 currentPid 赋值之间没有 await，
        // 取消要么在检查前生效（不启动本步），要么在赋值后触发 kill。
        const logger = this.logs.createStepLogger(this.runId, stageIndex, stepIndex, stage.name, step.name);
        const proc = spawnStep(step.command, step.args ?? [], step.cwd, step.env);
        this.currentPid = proc.pid;
        proc.stdout.on('data', (chunk: Buffer) => logger.writeStdout(chunk));
        proc.stderr.on('data', (chunk: Buffer) => logger.writeStderr(chunk));

        const { code, error } = await proc.exited;
        // 主程序退出后，先停止尚未停止的后代进程，再进入下一步。
        this.killCurrent();
        await this.currentKill;
        // 等 stdio 完全关闭（终止过程中迟到的输出也已到达），再封存日志。
        await proc.closed;
        await logger.finalize();
        this.currentPid = null;
        this.currentKill = null;

        // 取消优先于同时到达的退出通知：已受理取消的运行只能成为 Canceled。
        if (this.cancelRequested) break outer;
        if (error) {
          failedReason = `step "${step.name}" failed to start: ${error.message}`;
          break outer;
        }
        if (code !== 0) {
          failedReason = `step "${step.name}" exited with code ${code}`;
          break outer;
        }
      }
    }

    const now = Date.now();
    if (this.cancelRequested) {
      this.store.transition(this.runId, 'any-non-terminal', 'Canceled', 'canceled by request', now);
    } else if (failedReason !== null) {
      this.store.transition(this.runId, 'any-non-terminal', 'Failed', failedReason, now);
    } else {
      this.store.transition(this.runId, 'any-non-terminal', 'Passed', null, now);
    }
  }
}
