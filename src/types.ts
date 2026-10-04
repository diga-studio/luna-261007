/** 文件种类：一次发布固定包含一个 POM 和一个 JAR。 */
export type FileKind = "pom" | "jar";

/** 逻辑坐标 + 清单。版本必须以 "-SNAPSHOT" 结尾。 */
export interface Manifest {
  groupId: string;
  artifactId: string;
  /** 逻辑版本，必须以 "-SNAPSHOT" 结尾 */
  version: string;
  /** UTC 时间，用于生成实际版本，格式 yyyyMMdd.HHmmss */
  timestampUtc: string;
  files: Record<FileKind, FileDescriptor>;
}

export interface FileDescriptor {
  length: number;
  sha256: string;
}

/** 登记结果 / 发布记录。 */
export interface ReleaseInfo {
  publishId: string;
  manifest: Manifest;
  /** 实际版本，如 1.4-20261004.091500-7 */
  actualVersion: string;
  buildNumber: number;
  committed: boolean;
}

/** 当前快照查询结果。 */
export interface SnapshotInfo {
  groupId: string;
  artifactId: string;
  version: string;
  actualVersion: string;
  buildNumber: number;
}

export interface CommitResult {
  actualVersion: string;
  buildNumber: number;
}
