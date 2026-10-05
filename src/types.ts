/** 上传声明：调用方为每次上传提供的稳定标识与整体校验信息。 */
export interface UploadDeclaration {
  /** 稳定上传标识，同一标识代表同一份素材声明。 */
  uploadId: string;
  /** 素材总长度（字节），1 .. 100 MiB。 */
  totalSize: number;
  /** 完整内容的 SHA-256（小写十六进制，64 字符）。 */
  sha256: string;
}

/** 上传状态查询结果。 */
export interface UploadStatus {
  uploadId: string;
  totalSize: number;
  sha256: string;
  /** 已完整接收的分块序号（升序）。 */
  receivedChunks: number[];
  /** 已接收字节数（各已接收分块长度之和）。 */
  receivedBytes: number;
  /** 总分块数。 */
  totalChunks: number;
  /** 是否已完成入库。 */
  complete: boolean;
  /** 完成入库后的成品文件路径（未完成时不存在）。 */
  filePath?: string;
}

/** 完成入库结果。 */
export interface FinalizeResult {
  uploadId: string;
  filePath: string;
}

/** 测试/恢复用崩溃注入点。 */
export interface CrashHooks {
  /** 在指定注入点触发；用于测试模拟进程中断。 */
  onCrashPoint?: (point: CrashPoint) => void;
}

export type CrashPoint =
  | "chunk.tmpWritten"
  | "chunk.renamed"
  | "chunk.committed"
  | "finalize.tmpWritten"
  | "finalize.renamed"
  | "finalize.committed";

export interface StoreOptions {
  hooks?: CrashHooks;
}
