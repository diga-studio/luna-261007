/** 规范化绝对路径 -> 原始字节 */
export type FileTree = ReadonlyMap<string, Uint8Array>;

export type MutableFileTree = Map<string, Uint8Array>;

export interface CopyStep {
  readonly type: "copy";
  /** 来源阶段名；省略表示从 context 复制 */
  readonly from?: string;
  /** 源路径（文件或目录），可为多个 */
  readonly src: string | readonly string[];
  /** 目标路径：src 为文件时是目标文件路径，为目录时是目标目录 */
  readonly dest: string;
}

export interface RunStep {
  readonly type: "run";
  readonly command: string;
}

export type Step = CopyStep | RunStep;

export interface Stage {
  readonly name: string;
  /** 起始阶段名；省略表示从空树开始 */
  readonly from?: string;
  readonly steps: readonly Step[];
}

export interface Plan {
  readonly stages: readonly Stage[];
}

export interface RunResult {
  /** 写入文件：路径 -> 字节 */
  readonly writes: Readonly<Record<string, Uint8Array>>;
  /** 删除路径 */
  readonly deletes: readonly string[];
}

export type RunFn = (command: string, tree: FileTree) => Promise<RunResult>;

export interface BuilderOptions {
  readonly cacheDir: string;
  readonly run: RunFn;
}

export interface Builder {
  build(plan: Plan, context: FileTree, target: string): Promise<string>;
  readFile(imageId: string, path: string): Promise<Uint8Array | undefined>;
}
