import { randomUUID } from 'node:crypto';
import { RunStore } from './db';
import { LogStore } from './log-store';
import { RunExecution } from './run-executor';
import { TERMINAL_STATUSES, type CancelResult, type PipelineDefinition, type RunRecord, type RunnerOptions, type StepLogRef } from './types';

/** 对外入口：提交运行、申请取消、查看运行与日志。 */
export class PipelineRunner {
  private readonly store: RunStore;
  private readonly logs: LogStore;
  private readonly maxConcurrent: number;
  private readonly queue: RunExecution[] = [];
  private readonly executions = new Map<string, RunExecution>();
  private readonly active = new Map<string, Promise<void>>();
  private initialized = false;

  constructor(options: RunnerOptions) {
    this.store = new RunStore(options.dbPath);
    this.logs = new LogStore(options.logDir);
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 1);
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.store.init();
    // 上一个进程遗留的非终态运行：其进程已不存在，直接落 Failed。
    this.store.failNonTerminal('runner restarted before run completed', Date.now());
    this.initialized = true;
  }

  /** 提交一次运行，返回运行 id。状态初始为 Queued。 */
  async submit(definition: PipelineDefinition): Promise<string> {
    this.ensureInit();
    const id = randomUUID();
    this.store.insert(id, definition, Date.now());
    const execution = new RunExecution(id, definition, this.store, this.logs);
    this.executions.set(id, execution);
    this.queue.push(execution);
    this.pump();
    return id;
  }

  /** 申请取消。终态不受理；Queued 直接取消；Running 标记并停止当前步骤。 */
  cancel(runId: string): CancelResult {
    this.ensureInit();
    const record = this.store.get(runId);
    if (!record) throw new Error(`run not found: ${runId}`);
    if (TERMINAL_STATUSES.has(record.status)) {
      return { accepted: false, status: record.status };
    }
    if (record.status === 'Queued') {
      // 排队中的取消：直接进终态，调度器会跳过它，不会启动任何步骤。
      this.store.transition(runId, ['Queued'], 'Canceled', 'canceled while queued', Date.now());
      return { accepted: true, status: 'Canceled' };
    }
    const execution = this.executions.get(runId);
    const accepted = execution ? execution.requestCancel() : false;
    return { accepted, status: accepted ? 'Running' : record.status };
  }

  getRun(runId: string): RunRecord | null {
    this.ensureInit();
    return this.store.get(runId);
  }

  getLogs(runId: string): StepLogRef[] {
    this.ensureInit();
    return this.logs.listStepLogs(runId);
  }

  /** 等待全部在途运行结束（进程停止、日志保存）后关闭存储。 */
  async close(): Promise<void> {
    await Promise.all([...this.active.values()]);
    this.store.close();
  }

  /** 按提交顺序启动等待中的运行，跳过已取消的。 */
  private pump(): void {
    while (this.active.size < this.maxConcurrent && this.queue.length > 0) {
      const execution = this.queue.shift()!;
      const record = this.store.get(execution.runId);
      if (!record || record.status !== 'Queued') {
        this.executions.delete(execution.runId); // 已取消（或异常终态），跳过并释放引用
        continue;
      }
      const done = execution
        .run()
        .catch(() => {
          // 执行体内部已尽力落终态；此处兜底防止未处理拒绝。
        })
        .finally(() => {
          // 名额直到进程全停、日志保存完毕（run() resolve）才释放。
          this.active.delete(execution.runId);
          this.executions.delete(execution.runId);
          this.pump();
        });
      this.active.set(execution.runId, done);
    }
  }

  private ensureInit(): void {
    if (!this.initialized) throw new Error('PipelineRunner not initialized: call init() first');
  }
}
