import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type {
  CommitResult,
  FileKind,
  Manifest,
  RegisterResult,
  ReleaseInfo,
  RepoHooks,
} from './types.js';
import {
  CommitMismatchError,
  ManifestConflictError,
  RepoError,
  UnknownReleaseError,
} from './errors.js';
import { manifestEquals, validateManifest } from './manifest.js';
import { Store, type ReleaseRow } from './store.js';

const DB_FILE = 'repo.db';
const ARTIFACTS_DIR = 'artifacts';
const STAGING_DIR = 'staging';
const FINAL_DIR = 'final';

/** 发布标识对应的制品目录名（散列化，避免路径注入与非法字符）。 */
function releaseDirName(releaseId: string): string {
  return createHash('sha256').update(releaseId, 'utf8').digest('hex');
}

function rowToManifest(row: ReleaseRow): Manifest {
  return {
    groupId: row.groupId,
    artifactId: row.artifactId,
    version: row.version,
    timestampUtc: row.timestampUtc,
    pom: { length: row.pomLength, sha256: row.pomSha256 },
    jar: { length: row.jarLength, sha256: row.jarSha256 },
  };
}

function rowToInfo(row: ReleaseRow): ReleaseInfo {
  return {
    releaseId: row.releaseId,
    actualVersion: row.actualVersion,
    buildNumber: row.buildNumber,
    manifest: rowToManifest(row),
    committed: row.committed,
  };
}

/**
 * 本地 Maven 快照发布库。
 * 元数据存于 <dir>/repo.db（SQLite），制品存于 <dir>/artifacts/。
 */
export class SnapshotRepository {
  private constructor(
    private readonly dir: string,
    private readonly store: Store,
    private readonly hooks: RepoHooks,
  ) {}

  private get stagingRoot(): string {
    return path.join(this.dir, ARTIFACTS_DIR, STAGING_DIR);
  }

  private get finalRoot(): string {
    return path.join(this.dir, ARTIFACTS_DIR, FINAL_DIR);
  }

  private stagingDirOf(releaseId: string): string {
    return path.join(this.stagingRoot, releaseDirName(releaseId));
  }

  private finalDirOf(releaseId: string): string {
    return path.join(this.finalRoot, releaseDirName(releaseId));
  }

  /** 打开（必要时创建）仓库，并执行崩溃恢复。 */
  static open(dir: string, hooks: RepoHooks = {}): SnapshotRepository {
    fs.mkdirSync(path.join(dir, ARTIFACTS_DIR, STAGING_DIR), { recursive: true });
    fs.mkdirSync(path.join(dir, ARTIFACTS_DIR, FINAL_DIR), { recursive: true });
    const store = new Store(path.join(dir, DB_FILE));
    const repo = new SnapshotRepository(dir, store, hooks);
    repo.recover();
    return repo;
  }

  /**
   * 恢复：目录级 rename 是原子的，因此最终目录存在即代表两个文件完整。
   * 未完成的发布若已有完整最终目录则补记为完成；暂存区残留一律清除。
   */
  private recover(): void {
    for (const row of this.store.pendingReleases()) {
      if (fs.existsSync(this.finalDirOf(row.releaseId))) {
        this.store.markCommitted(row.releaseId);
      }
      this.hooks.duringRecovery?.();
    }
    for (const entry of fs.readdirSync(this.stagingRoot)) {
      fs.rmSync(path.join(this.stagingRoot, entry), { recursive: true, force: true });
    }
  }

  close(): void {
    this.store.close();
  }

  /**
   * 登记发布。相同标识+相同清单重复登记返回原实际版本；
   * 相同标识不同清单抛 ManifestConflictError。
   */
  register(releaseId: string, manifest: Manifest): RegisterResult {
    validateManifest(manifest);
    const existing = this.store.findRelease(releaseId);
    if (existing) {
      if (!manifestEquals(rowToManifest(existing), manifest)) {
        throw new ManifestConflictError(
          `release id ${releaseId} already bound to a different manifest`,
        );
      }
      return { actualVersion: existing.actualVersion, buildNumber: existing.buildNumber };
    }
    const row = this.store.insertRelease(manifest, releaseId);
    this.hooks.afterRegister?.();
    return { actualVersion: row.actualVersion, buildNumber: row.buildNumber };
  }

  /**
   * 提交两个本地源文件。校验失败抛 CommitMismatchError，可重试；
   * 已完成发布的重复提交返回原结果。
   */
  commit(releaseId: string, pomPath: string, jarPath: string): CommitResult {
    const row = this.store.findRelease(releaseId);
    if (!row) {
      throw new UnknownReleaseError(`unknown release id: ${releaseId}`);
    }
    if (row.committed) {
      return { actualVersion: row.actualVersion, buildNumber: row.buildNumber };
    }
    verifyFileSync(pomPath, row.pomLength, row.pomSha256);
    verifyFileSync(jarPath, row.jarLength, row.jarSha256);

    const stagingDir = this.stagingDirOf(releaseId);
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.mkdirSync(stagingDir, { recursive: true });
    copyVerified(pomPath, path.join(stagingDir, 'pom'));
    copyVerified(jarPath, path.join(stagingDir, 'jar'));
    this.hooks.afterStaged?.();

    const finalDir = this.finalDirOf(releaseId);
    fs.rmSync(finalDir, { recursive: true, force: true });
    fs.renameSync(stagingDir, finalDir);
    this.hooks.afterArtifactsRenamed?.();

    this.store.markCommitted(releaseId);
    return { actualVersion: row.actualVersion, buildNumber: row.buildNumber };
  }

  /** 当前快照：该逻辑坐标下已完成发布中构建号最大者；无则 null。 */
  currentSnapshot(groupId: string, artifactId: string, version: string): ReleaseInfo | null {
    const row = this.store.latestCommitted(groupId, artifactId, version);
    return row ? rowToInfo(row) : null;
  }

  /** 按实际版本读取已完成发布的文件内容流。 */
  readFile(
    groupId: string,
    artifactId: string,
    actualVersion: string,
    kind: FileKind,
  ): Readable {
    const row = this.store.findCommittedByActualVersion(groupId, artifactId, actualVersion);
    if (!row) {
      throw new UnknownReleaseError(
        `no committed release: ${groupId}:${artifactId}:${actualVersion}`,
      );
    }
    return fs.createReadStream(path.join(this.finalDirOf(row.releaseId), kind));
  }
}

/** 同步流式校验（1MiB 缓冲，峰值内存远低于 64MiB 限制）。 */
function verifyFileSync(filePath: string, expectedLength: number, expectedSha256: string): void {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch (err) {
    throw new RepoError(`cannot read source file: ${filePath}`, { cause: err });
  }
  try {
    const stat = fs.fstatSync(fd);
    if (stat.size !== expectedLength) {
      throw new CommitMismatchError(
        `${filePath}: length ${stat.size} != manifest ${expectedLength}`,
      );
    }
    const hash = createHash('sha256');
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, offset);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
      offset += n;
    }
    if (offset !== expectedLength) {
      throw new CommitMismatchError(
        `${filePath}: read ${offset} bytes != manifest ${expectedLength}`,
      );
    }
    const actual = hash.digest('hex');
    if (actual !== expectedSha256) {
      throw new CommitMismatchError(`${filePath}: sha256 ${actual} != manifest ${expectedSha256}`);
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** 同步流式复制并 fsync（1MiB 缓冲）。 */
function copyVerified(src: string, dst: string): void {
  const input = fs.openSync(src, 'r');
  try {
    const output = fs.openSync(dst, 'w');
    try {
      const buf = Buffer.allocUnsafe(1024 * 1024);
      let offset = 0;
      for (;;) {
        const n = fs.readSync(input, buf, 0, buf.length, offset);
        if (n === 0) break;
        fs.writeSync(output, buf, 0, n);
        offset += n;
      }
      fs.fsyncSync(output);
    } finally {
      fs.closeSync(output);
    }
  } finally {
    fs.closeSync(input);
  }
}
