/**
 * 崩溃模拟子进程入口。
 * 用法: node crash-helper.js <scenario> <repoDir> [args...]
 * 场景:
 *   register-kill <manifestJsonFile> <publishId>
 *   commit-kill-before-record <manifestJsonFile> <publishId> <pomPath> <jarPath>
 *   commit-kill-after-record  <manifestJsonFile> <publishId> <pomPath> <jarPath>
 *   recover-kill
 */
import * as fs from "node:fs";
import { Manifest, SnapshotRepository } from "../src/index";

const [, , scenario, repoDir, ...rest] = process.argv;

function killSelf(): never {
  process.kill(process.pid, "SIGKILL");
  throw new Error("unreachable");
}

function readManifest(file: string): Manifest {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Manifest;
}

switch (scenario) {
  case "register-kill": {
    const [manifestFile, publishId] = rest;
    const repo = SnapshotRepository.open(repoDir!);
    repo.register(publishId!, readManifest(manifestFile!));
    killSelf();
  }
  case "commit-kill-before-record": {
    const [manifestFile, publishId, pomPath, jarPath] = rest;
    const repo = SnapshotRepository.open(repoDir!, {
      hooks: { beforeCommitRecord: killSelf },
    });
    repo.register(publishId!, readManifest(manifestFile!));
    repo.commit(publishId!, pomPath!, jarPath!);
    killSelf();
  }
  case "commit-kill-after-record": {
    const [manifestFile, publishId, pomPath, jarPath] = rest;
    const repo = SnapshotRepository.open(repoDir!, {
      hooks: { afterCommitRecord: killSelf },
    });
    repo.register(publishId!, readManifest(manifestFile!));
    repo.commit(publishId!, pomPath!, jarPath!);
    killSelf();
  }
  case "recover-kill": {
    const repo = SnapshotRepository.open(repoDir!, {
      hooks: { duringRecovery: killSelf },
    });
    repo.close();
    break;
  }
  default:
    throw new Error(`未知场景: ${scenario}`);
}
