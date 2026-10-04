import * as fs from "node:fs";
import * as path from "node:path";
import { FileKind } from "./types";

/**
 * 制品存储：本地目录下的文件落盘、暂存与清理。
 *
 * 布局：
 *   <root>/artifacts/<releaseKey>/pom|jar   最终制品（rename 原子就位）
 *   <root>/staging/                          复制中的临时文件
 */
export class ArtifactStore {
  private readonly artifactsDir: string;
  private readonly stagingDir: string;

  constructor(rootDir: string) {
    this.artifactsDir = path.join(rootDir, "artifacts");
    this.stagingDir = path.join(rootDir, "staging");
    fs.mkdirSync(this.artifactsDir, { recursive: true });
    fs.mkdirSync(this.stagingDir, { recursive: true });
  }

  private releaseDir(releaseKey: string): string {
    return path.join(this.artifactsDir, encodeURIComponent(releaseKey));
  }

  artifactPath(releaseKey: string, kind: FileKind): string {
    return path.join(this.releaseDir(releaseKey), kind);
  }

  /**
   * 将源文件经暂存区原子地安放为指定发布的制品。
   * 先复制到暂存文件并 fsync，再 rename 到最终位置并 fsync 目录。
   */
  install(releaseKey: string, kind: FileKind, sourcePath: string): void {
    const stagingFile = path.join(
      this.stagingDir,
      `${process.pid}-${Date.now()}-${encodeURIComponent(releaseKey)}-${kind}`
    );
    fs.copyFileSync(sourcePath, stagingFile);
    const fd = fs.openSync(stagingFile, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const targetDir = this.releaseDir(releaseKey);
    fs.mkdirSync(targetDir, { recursive: true });
    fs.renameSync(stagingFile, path.join(targetDir, kind));
    const dirFd = fs.openSync(targetDir, "r");
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  }

  removeRelease(releaseKey: string): void {
    fs.rmSync(this.releaseDir(releaseKey), { recursive: true, force: true });
  }

  cleanStaging(): void {
    for (const entry of fs.readdirSync(this.stagingDir)) {
      fs.rmSync(path.join(this.stagingDir, entry), { recursive: true, force: true });
    }
  }

  read(releaseKey: string, kind: FileKind): Buffer {
    return fs.readFileSync(this.artifactPath(releaseKey, kind));
  }
}
