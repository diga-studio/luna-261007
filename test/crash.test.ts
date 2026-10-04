import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { PublishIdConflictError, SnapshotRepository } from "../src/index";
import { Fixture, makeFixture, tempDir } from "./helpers";

const HELPER = path.join(__dirname, "crash-helper.js");

function runChild(scenario: string, repoDir: string, ...args: string[]): void {
  const r = spawnSync(process.execPath, [HELPER, scenario, repoDir, ...args], {
    stdio: "pipe",
  });
  assert.equal(
    r.signal,
    "SIGKILL",
    `子进程应被 SIGKILL 终止, 实际: status=${r.status} signal=${r.signal} stderr=${r.stderr}`
  );
}

function writeManifest(dir: string, fx: Fixture): string {
  const p = path.join(dir, "manifest.json");
  fs.writeFileSync(p, JSON.stringify(fx.manifest));
  return p;
}

/** 递归收集目录下所有文件路径（相对 root）。 */
function listFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const walk = (cur: string) => {
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(root, p));
    }
  };
  walk(root);
  return out;
}

test("登记后中断：重开库相同标识返回原实际版本，构建号不复用，冲突清单不重新绑定", () => {
  const dir = tempDir("crash-register");
  const fx = makeFixture(dir, "a");
  const mf = writeManifest(dir, fx);
  runChild("register-kill", dir, mf, "p1");

  const repo = SnapshotRepository.open(dir);
  const again = repo.register("p1", fx.manifest);
  assert.equal(again.actualVersion, "1.4-20261004.091500-1");
  // 冲突清单：拒绝且不重新绑定
  const other = makeFixture(dir, "b");
  assert.throws(() => repo.register("p1", other.manifest), PublishIdConflictError);
  assert.equal(repo.register("p1", fx.manifest).actualVersion, again.actualVersion);
  // 新标识拿到下一个号，1 号不复用也不跳过
  const next = repo.register("p2", fx.manifest);
  assert.equal(next.buildNumber, 2);
  repo.close();

  // 再次重开仍成立
  const repo2 = SnapshotRepository.open(dir);
  assert.equal(repo2.register("p1", fx.manifest).actualVersion, again.actualVersion);
  repo2.close();
});

test("制品已写入但提交记录未写入时中断：无半份发布、无残留，重试收敛到同一完整发布", () => {
  const dir = tempDir("crash-commit");
  const fx = makeFixture(dir, "a");
  const mf = writeManifest(dir, fx);
  runChild("commit-kill-before-record", dir, mf, "p1", fx.pomPath, fx.jarPath);

  const repo = SnapshotRepository.open(dir);
  // 登记保留，实际版本不变
  const info = repo.register("p1", fx.manifest);
  assert.equal(info.actualVersion, "1.4-20261004.091500-1");
  assert.equal(info.committed, false);
  // 没有半份发布：两个文件都不可读，当前快照为空
  assert.throws(() => repo.readFile(info.actualVersion, "pom"));
  assert.throws(() => repo.readFile(info.actualVersion, "jar"));
  assert.equal(repo.currentSnapshot("com.example", "demo", "1.4-SNAPSHOT"), null);
  // 无未完成制品残留
  assert.deepEqual(listFiles(path.join(dir, "artifacts")), []);
  assert.deepEqual(listFiles(path.join(dir, "staging")), []);
  // 重试收敛到同一实际版本的完整发布
  const result = repo.commit("p1", fx.pomPath, fx.jarPath);
  assert.equal(result.actualVersion, info.actualVersion);
  assert.deepEqual(repo.readFile(info.actualVersion, "pom"), fx.pomContent);
  assert.deepEqual(repo.readFile(info.actualVersion, "jar"), fx.jarContent);
  repo.close();
});

test("恢复再次中断：下一次恢复仍清理未完成制品并保留登记", () => {
  const dir = tempDir("crash-recover");
  const fx = makeFixture(dir, "a");
  const mf = writeManifest(dir, fx);
  runChild("commit-kill-before-record", dir, mf, "p1", fx.pomPath, fx.jarPath);
  // 第一次恢复在清理过程中被杀死
  runChild("recover-kill", dir);

  const repo = SnapshotRepository.open(dir);
  const info = repo.register("p1", fx.manifest);
  assert.equal(info.actualVersion, "1.4-20261004.091500-1");
  assert.deepEqual(listFiles(path.join(dir, "artifacts")), []);
  assert.deepEqual(listFiles(path.join(dir, "staging")), []);
  repo.commit("p1", fx.pomPath, fx.jarPath);
  assert.deepEqual(repo.readFile(info.actualVersion, "jar"), fx.jarContent);
  repo.close();
});

test("提交记录已写但响应未返回时中断：已完成发布不丢失，重复提交不重复留存制品", () => {
  const dir = tempDir("crash-after-record");
  const fx = makeFixture(dir, "a");
  const mf = writeManifest(dir, fx);
  runChild("commit-kill-after-record", dir, mf, "p1", fx.pomPath, fx.jarPath);

  const repo = SnapshotRepository.open(dir);
  const info = repo.register("p1", fx.manifest);
  assert.equal(info.committed, true);
  assert.deepEqual(repo.readFile(info.actualVersion, "pom"), fx.pomContent);
  assert.deepEqual(repo.readFile(info.actualVersion, "jar"), fx.jarContent);
  // 重复提交返回原结果，不生成新版本
  const again = repo.commit("p1", fx.pomPath, fx.jarPath);
  assert.equal(again.actualVersion, info.actualVersion);
  // 制品只有一份（pom + jar 两个文件）
  assert.deepEqual(listFiles(path.join(dir, "artifacts")).sort(), ["p1/pom", "p1/jar"].sort());
  repo.close();
});

test("暂存区垃圾与孤儿制品在重开时被清理", () => {
  const dir = tempDir("junk");
  let repo = SnapshotRepository.open(dir);
  const fx = makeFixture(dir, "a");
  const info = repo.register("p1", fx.manifest);
  repo.close();
  // 手工制造中断现场：暂存文件 + 未提交发布的制品字节
  fs.writeFileSync(path.join(dir, "staging", "leftover.tmp"), "junk");
  const releaseDir = path.join(dir, "artifacts", "p1");
  fs.mkdirSync(releaseDir, { recursive: true });
  fs.writeFileSync(path.join(releaseDir, "pom"), fx.pomContent);

  repo = SnapshotRepository.open(dir);
  assert.deepEqual(listFiles(path.join(dir, "artifacts")), []);
  assert.deepEqual(listFiles(path.join(dir, "staging")), []);
  assert.throws(() => repo.readFile(info.actualVersion, "pom"));
  repo.commit("p1", fx.pomPath, fx.jarPath);
  assert.deepEqual(repo.readFile(info.actualVersion, "pom"), fx.pomContent);
  repo.close();
});
