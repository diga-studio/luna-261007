export class RepoError extends Error {}

/** 同一发布标识绑定了不同清单。 */
export class ManifestConflictError extends RepoError {}

/** 提交的文件与登记清单不符。 */
export class CommitMismatchError extends RepoError {}

/** 发布标识不存在。 */
export class UnknownReleaseError extends RepoError {}

/** 清单本身不合法。 */
export class InvalidManifestError extends RepoError {}
