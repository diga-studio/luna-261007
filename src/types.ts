/** 隔离操作结果 */
export type QuarantineResult =
  | { status: "ok"; quarantineId: string }
  | { status: "not_found" }
  | { status: "hash_mismatch" };

/** 恢复操作结果 */
export type RestoreResult =
  | { status: "ok" }
  | { status: "conflict" }
  | { status: "not_found" };

/** 命令记录（用于幂等重放） */
export interface CommandRecord {
  commandId: string;
  op: "quarantine" | "restore";
  resultJson: string;
}

/** 隔离条目元数据 */
export interface QuarantineEntry {
  quarantineId: string;
  relativePath: string;
  sha256: string;
  status: "quarantined" | "restored";
}
