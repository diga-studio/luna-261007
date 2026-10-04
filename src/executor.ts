import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { MetadataStore } from "./db.js";
import type { QuarantineResult, RestoreResult } from "./types.js";

export interface ExecutorOptions {
  /** 原文件区根目录 */
  originalRoot: string;
  /** 隔离区根目录（与原文件区同一文件系统） */
  quarantineRoot: string;
  /** SQLite 元数据文件路径 */
  dbPath: string;
}

function sha256File(filePath: string): string {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

/** 将相对路径解析到 root 内；越界（绝对路径/..）时返回 null */
function resolveWithin(root: string, relativePath: string): string | null {
  if (path.isAbsolute(relativePath)) return null;
  const resolved = path.resolve(root, relativePath);
  const rel = path.relative(root, resolved);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return resolved;
}

/** SentinelCore 本地文件隔离执行器（命令串行执行） */
export class QuarantineExecutor {
  private readonly originalRoot: string;
  private readonly quarantineRoot: string;
  private readonly store: MetadataStore;

  constructor(options: ExecutorOptions) {
    this.originalRoot = path.resolve(options.originalRoot);
    this.quarantineRoot = path.resolve(options.quarantineRoot);
    fs.mkdirSync(this.quarantineRoot, { recursive: true });
    this.store = new MetadataStore(options.dbPath);
  }

  quarantine(commandId: string, relativePath: string, expectedSha256: string): QuarantineResult {
    const replayed = this.replay<QuarantineResult>(commandId, "quarantine");
    if (replayed !== undefined) return replayed;

    const result = this.doQuarantine(commandId, relativePath, expectedSha256);
    this.store.recordCommand(commandId, "quarantine", result);
    return result;
  }

  private doQuarantine(commandId: string, relativePath: string, expectedSha256: string): QuarantineResult {
    const src = resolveWithin(this.originalRoot, relativePath);
    if (src === null) return { status: "not_found" };

    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(src);
    } catch {
      return { status: "not_found" };
    }
    if (!stat.isFile()) return { status: "not_found" };

    const actualSha256 = sha256File(src);
    if (actualSha256 !== expectedSha256.toLowerCase()) {
      // 摘要不符：不得改变原文件
      return { status: "hash_mismatch" };
    }

    const quarantinePath = path.join(this.quarantineRoot, `${commandId}.quar`);
    // 同一文件系统上的 rename：原子地把文件移入隔离区
    fs.renameSync(src, quarantinePath);
    try {
      this.store.createEntry({
        quarantineId: commandId,
        relativePath,
        sha256: actualSha256,
        status: "quarantined",
      });
    } catch (err) {
      // 元数据写入失败则回滚文件移动，避免内容丢失
      fs.renameSync(quarantinePath, src);
      throw err;
    }
    return { status: "ok", quarantineId: commandId };
  }

  restore(commandId: string, quarantineId: string): RestoreResult {
    const replayed = this.replay<RestoreResult>(commandId, "restore");
    if (replayed !== undefined) return replayed;

    const result = this.doRestore(quarantineId);
    this.store.recordCommand(commandId, "restore", result);
    return result;
  }

  private doRestore(quarantineId: string): RestoreResult {
    const entry = this.store.findEntry(quarantineId);
    if (!entry || entry.status !== "quarantined") return { status: "not_found" };

    const dest = resolveWithin(this.originalRoot, entry.relativePath);
    if (dest === null) return { status: "not_found" };

    // 路径被任何文件占用（即使字节完全相同）即冲突，保留隔离内容
    if (fs.existsSync(dest)) return { status: "conflict" };

    const quarantinePath = path.join(this.quarantineRoot, `${entry.quarantineId}.quar`);
    if (!fs.existsSync(quarantinePath)) return { status: "not_found" };

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // 同一文件系统上的 rename：原子发布完整文件，不暴露半个文件，隔离区无残留
    fs.renameSync(quarantinePath, dest);
    this.store.markRestored(entry.quarantineId);
    return { status: "ok" };
  }

  private replay<T>(commandId: string, op: "quarantine" | "restore"): T | undefined {
    const record = this.store.findCommand(commandId);
    if (!record) return undefined;
    if (record.op !== op) {
      throw new Error(`commandId ${commandId} already used for op ${record.op}`);
    }
    return JSON.parse(record.resultJson) as T;
  }

  close(): void {
    this.store.close();
  }
}
