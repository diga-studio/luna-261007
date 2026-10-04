/** 清单中单个文件的描述。 */
export interface FileSpec {
  /** 文件字节长度。 */
  length: number;
  /** 文件内容的 SHA-256，小写十六进制。 */
  sha256: string;
}

/** 登记发布时调用方提供的清单。 */
export interface Manifest {
  groupId: string;
  artifactId: string;
  /** 逻辑版本，必须以 "-SNAPSHOT" 结尾。 */
  version: string;
  /** UTC 时间，格式 yyyyMMdd.HHmmss。 */
  timestampUtc: string;
  pom: FileSpec;
  jar: FileSpec;
}

export type FileKind = 'pom' | 'jar';

export interface ReleaseInfo {
  releaseId: string;
  actualVersion: string;
  buildNumber: number;
  manifest: Manifest;
  committed: boolean;
}

export interface RegisterResult {
  actualVersion: string;
  buildNumber: number;
}

export interface CommitResult {
  actualVersion: string;
  buildNumber: number;
}

/** 测试/诊断用的崩溃注入钩子；生产调用传空即可。 */
export interface RepoHooks {
  /** 登记事务提交之后触发。 */
  afterRegister?: () => void;
  /** 制品已写入暂存区并完成 fsync 之后触发。 */
  afterStaged?: () => void;
  /** 制品已原子 rename 到最终位置、数据库尚未标记完成时触发。 */
  afterArtifactsRenamed?: () => void;
  /** 恢复过程中每处理完一个未完成发布的清理步骤后触发。 */
  duringRecovery?: () => void;
}
