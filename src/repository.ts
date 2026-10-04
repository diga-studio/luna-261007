import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ArtifactStore } from "./artifacts";
import { MetadataStore } from "./database";
import {
  ArtifactNotFoundError,
  ChecksumMismatchError,
  InvalidManifestError,
  PublishIdConflictError,
  UnknownPublishIdError,
} from "./errors";
import { CommitResult, FileKind, Manifest, ReleaseInfo, SnapshotInfo } from "./types";

/** 测试/恢复钩子：在关键持久化节点回调，用于模拟进程中断。 */
export interface CrashHooks {
  /** 制品已安放、提交记录尚未写入之前。 */
  beforeCommitRecord?: () => void;
  /** 提交记录已写入、结果尚未返回调用方之前。 */
  afterCommitRecord?: () => void;
  /** 恢复过程中每清理一个发布之前。 */
  duringRecovery?: (step: string) => void;
}

export interface OpenOptions {
  hooks?: CrashHooks;
}

const SNAPSHOT_SUFFIX = "-SNAPSHOT";
const TIMESTAMP_PATTERN = /^\d{8}\.\d{6}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const HASH_CHUNK_SIZE = 1024 * 1024;

function validateManifest(manifest: Manifest): void {
  if (!manifest || typeof manifest !== "object") throw new InvalidManifestError("manifest 缺失");
  const { groupId, artifactId, version, timestampUtc, files } = manifest;
  if (!groupId || !artifactId) throw new InvalidManifestError("groupId/artifactId 不能为空");
  if (typeof version !== "string" || !version.endsWith(SNAPSHOT_SUFFIX)) {
    throw new InvalidManifestError(`逻辑版本必须以 ${SNAPSHOT_SUFFIX} 结尾: ${version}`);
  }
  if (typeof timestampUtc !== "string" || !TIMESTAMP_PATTERN.test(timestampUtc)) {
    throw new InvalidManifestError(`timestampUtc 必须是 yyyyMMdd.HHmmss 格式: ${timestampUtc}`);
  }
  for (const kind of ["pom", "jar"] as FileKind[]) {
    const f = files?.[kind];
    if (!f || !Number.isSafeInteger(f.length) || f.length < 0 || !SHA256_PATTERN.test(f.sha256)) {
      throw new InvalidManifestError(`files.${kind} 需要非负 length 与 64 位小写 sha256`);
    }
  }
}

function manifestsEqual(a: Manifest, b: Manifest): boolean {
  const canon = (m: Manifest) =>
    JSON.stringify({
      groupId: m.groupId,
      artifactId: m.artifactId,
      version: m.version,
      timestampUtc: m.timestampUtc,
      files: {
        pom: { length: m.files.pom.length, sha256: m.files.pom.sha256 },
        jar: { length: m.files.jar.length, sha256: m.files.jar.sha256 },
      },
    });
  return canon(a) === canon(b);
}

/** 流式计算文件长度与 SHA-256，单次只缓冲 1 MiB。 */
function fingerprint(filePath: string): { length: number; sha256: string } {
  const hash = crypto.createHash("sha256");
  const buf = Buffer.allocUnsafe(HASH_CHUNK_SIZE);
  let length = 0;
  const fd = fs.openSync(filePath, "r");
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
      length += n;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { length, sha256: hash.digest("hex") };
}

/**
 * Maven SNAPSHOT 本地发布库。
 * 元数据存 SQLite，制品存本地目录；调用需串行。
 */
export class SnapshotRepository {
  private readonly store: MetadataStore;
  private readonly artifacts: ArtifactStore;
  private readonly hooks: CrashHooks;

  private constructor(store: MetadataStore, artifacts: ArtifactStore, hooks: CrashHooks) {
    this.store = store;
    this.artifacts = artifacts;
    this.hooks = hooks;
  }

  /** 打开（必要时创建）仓库，并执行恢复。 */
  static open(repoDir: string, options?: OpenOptions): SnapshotRepository {
    fs.mkdirSync(repoDir, { recursive: true });
    const store = new MetadataStore(path.join(repoDir, "meta.db"));
    const artifacts = new ArtifactStore(repoDir);
    const hooks = options?.hooks ?? {};
    const repo = new SnapshotRepository(store, artifacts, hooks);
    repo.recover();
    return repo;
  }

  /**
   * 恢复：清空暂存区；删除未完成发布的全部制品字节。
   * 登记记录与构建号保留，供之后重试。可重入：再次中断后重跑仍收敛。
   */
  private recover(): void {
    this.artifacts.cleanStaging();
    for (const info of this.store.listUncommitted()) {
      this.hooks.duringRecovery?.(info.publishId);
      this.artifacts.removeRelease(info.publishId);
    }
  }

  close(): void {
    this.store.close();
  }

  /**
   * 登记发布：分配实际版本。
   * 相同标识 + 相同清单重复登记返回原实际版本；清单不同则抛错。
   */
  register(publishId: string, manifest: Manifest): ReleaseInfo {
    if (!publishId) throw new InvalidManifestError("publishId 不能为空");
    validateManifest(manifest);
    const existing = this.store.getByPublishId(publishId);
    if (existing) {
      if (!manifestsEqual(existing.manifest, manifest)) {
        throw new PublishIdConflictError(`发布标识 ${publishId} 已绑定不同清单`);
      }
      return existing;
    }
    const base = manifest.version.slice(0, -"SNAPSHOT".length) + manifest.timestampUtc;
    const info: ReleaseInfo = {
      publishId,
      manifest,
      actualVersion: base,
      buildNumber: 0,
      committed: false,
    };
    this.store.insertRegistered(info);
    return info;
  }

  /**
   * 提交文件：校验长度与 SHA-256，两个文件整体可见。
   * 已完成发布的重复提交返回原结果。
   */
  commit(publishId: string, pomPath: string, jarPath: string): CommitResult {
    const info = this.store.getByPublishId(publishId);
    if (!info) throw new UnknownPublishIdError(`未知发布标识: ${publishId}`);
    if (info.committed) {
      return { actualVersion: info.actualVersion, buildNumber: info.buildNumber };
    }
    for (const [kind, sourcePath] of [
      ["pom", pomPath],
      ["jar", jarPath],
    ] as [FileKind, string][]) {
      const expected = info.manifest.files[kind];
      const actual = fingerprint(sourcePath);
      if (actual.length !== expected.length || actual.sha256 !== expected.sha256) {
        throw new ChecksumMismatchError(
          `${kind} 与登记清单不符: 期望 ${expected.length}/${expected.sha256}，实际 ${actual.length}/${actual.sha256}`
        );
      }
    }
    this.artifacts.install(publishId, "pom", pomPath);
    this.artifacts.install(publishId, "jar", jarPath);
    this.hooks.beforeCommitRecord?.();
    this.store.markCommitted(publishId);
    this.hooks.afterCommitRecord?.();
    return { actualVersion: info.actualVersion, buildNumber: info.buildNumber };
  }

  /** 当前快照：已完成发布中构建号最大者；无则 null。 */
  currentSnapshot(groupId: string, artifactId: string, version: string): SnapshotInfo | null {
    const info = this.store.findCurrentSnapshot(groupId, artifactId, version);
    if (!info) return null;
    return {
      groupId,
      artifactId,
      version,
      actualVersion: info.actualVersion,
      buildNumber: info.buildNumber,
    };
  }

  /** 按实际版本读取已完成发布的文件内容。 */
  readFile(actualVersion: string, kind: FileKind): Buffer {
    const info = this.store.getByActualVersion(actualVersion);
    if (!info) throw new ArtifactNotFoundError(`未找到已完成发布: ${actualVersion}`);
    return this.artifacts.read(info.publishId, kind);
  }
}
