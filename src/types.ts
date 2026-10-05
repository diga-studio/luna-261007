/** 规范化绝对路径 -> 原始字节。 */
export type FileTree = ReadonlyMap<string, Uint8Array>;

export interface CopyStep {
  readonly type: 'copy';
  /** 来源阶段名；缺省表示从 context 复制。 */
  readonly from?: string;
  /** 源文件或目录的规范化绝对路径。 */
  readonly source: string;
  /** 目标路径：文件复制到该路径，目录子树复制到该目录下。 */
  readonly dest: string;
}

export interface RunStep {
  readonly type: 'run';
  readonly command: string;
}

export type Step = CopyStep | RunStep;

export interface Stage {
  readonly name: string;
  /** 起始阶段名；缺省表示从空树开始。 */
  readonly from?: string;
  readonly steps: readonly Step[];
}

export interface Plan {
  readonly stages: readonly Stage[];
}

export interface RunOutput {
  /** 写入文件：规范化绝对路径 -> 字节。 */
  readonly writes?: FileTree;
  /** 删除路径（文件或目录子树）。 */
  readonly deletes?: readonly string[];
}

/** 确定性异步函数：给定命令与只读当前树，返回写入与删除。 */
export type RunFn = (command: string, tree: FileTree) => Promise<RunOutput>;

export interface BuilderOptions {
  readonly cacheDir: string;
  readonly run: RunFn;
}

export interface Builder {
  /** 构建目标阶段及其必要依赖，返回最终树的 imageId。 */
  build(plan: Plan, context: FileTree, target: string): Promise<string>;
  /** 按 imageId 与路径逐字节读回文件；不存在返回 undefined。 */
  readFile(imageId: string, path: string): Promise<Uint8Array | undefined>;
}
