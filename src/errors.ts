export class SnapshotRepoError extends Error {}

/** 逻辑版本不合法（未以 -SNAPSHOT 结尾）或时间格式不合法。 */
export class InvalidManifestError extends SnapshotRepoError {}

/** 相同发布标识绑定了不同清单。 */
export class PublishIdConflictError extends SnapshotRepoError {}

/** 发布标识不存在。 */
export class UnknownPublishIdError extends SnapshotRepoError {}

/** 提交文件与登记清单不一致（长度或 SHA-256）。 */
export class ChecksumMismatchError extends SnapshotRepoError {}

/** 按实际版本读取时找不到对应文件。 */
export class ArtifactNotFoundError extends SnapshotRepoError {}
