/** 流水线定义（调用方已完成 YAML 解析）。 */
export interface PipelineDefinition {
  stages: StageDefinition[];
}

export interface StageDefinition {
  /** 通常为 Build / Test / Deploy，按数组顺序执行。 */
  name: string;
  steps: StepDefinition[];
}

export interface StepDefinition {
  name: string;
  /** 本地可执行程序。 */
  command: string;
  args?: string[];
  /** 工作目录，缺省为调用方进程 cwd。 */
  cwd?: string;
  env?: Record<string, string>;
}

export type RunStatus = 'Queued' | 'Running' | 'Passed' | 'Failed' | 'Canceled';

export const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set(['Passed', 'Failed', 'Canceled']);

export interface RunRecord {
  id: string;
  status: RunStatus;
  definition: PipelineDefinition;
  /** 失败/取消时的说明，成功时为空。 */
  reason: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CancelResult {
  /** 取消是否被受理（终态运行的取消不受理）。 */
  accepted: boolean;
  status: RunStatus;
}

export interface StepLogRef {
  stage: string;
  step: string;
  stdoutPath: string;
  stderrPath: string;
}

export interface RunnerOptions {
  /** SQLite 数据库文件路径。 */
  dbPath: string;
  /** 日志根目录（调用方指定）。 */
  logDir: string;
  /** 并发执行名额，默认 1。 */
  maxConcurrent?: number;
}
