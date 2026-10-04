import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";
import {
  ChecksumMismatchError,
  InvalidManifestError,
  PublishIdConflictError,
  SnapshotRepository,
  UnknownPublishIdError,
} from "../src/index";
import { makeFixture, tempDir } from "./helpers";

test("登记分配实际版本：时间替换 SNAPSHOT 并追加构建号", () => {
  const dir = tempDir("basic");
  const repo = SnapshotRepository.open(dir);
  const fx = makeFixture(dir, "a");
  const info = repo.register("pub-1", fx.manifest);
  assert.equal(info.actualVersion, "1.4-20261004.091500-1");
  assert.equal(info.buildNumber, 1);
  assert.equal(info.committed, false);
  repo.close();
});

test("同一坐标构建号从 1 递增，未提交的号码也不复用", () => {
  const dir = tempDir("buildnum");
  const repo = SnapshotRepository.open(dir);
  const fx = makeFixture(dir, "a");
  const r1 = repo.register("p1", fx.manifest);
  const r2 = repo.register("p2", fx.manifest);
  assert.equal(r1.buildNumber, 1);
  assert.equal(r2.buildNumber, 2);
  // 只提交 p2，p1 的号 1 已被占用
  repo.commit("p2", fx.pomPath, fx.jarPath);
  const r3 = repo.register("p3", fx.manifest);
  assert.equal(r3.buildNumber, 3);
  repo.close();
});

test("相同标识相同清单重复登记返回原实际版本，重开库后仍成立", () => {
  const dir = tempDir("idem");
  const fx = makeFixture(dir, "a");
  let repo = SnapshotRepository.open(dir);
  const first = repo.register("p1", fx.manifest);
  const again = repo.register("p1", fx.manifest);
  assert.equal(again.actualVersion, first.actualVersion);
  repo.close();

  repo = SnapshotRepository.open(dir);
  const afterReopen = repo.register("p1", fx.manifest);
  assert.equal(afterReopen.actualVersion, first.actualVersion);
  // 新标识继续递增，不复用
  const next = repo.register("p2", fx.manifest);
  assert.equal(next.buildNumber, first.buildNumber + 1);
  repo.close();
});

test("相同标识不同清单拒绝重新绑定", () => {
  const dir = tempDir("conflict");
  const repo = SnapshotRepository.open(dir);
  const fx = makeFixture(dir, "a");
  repo.register("p1", fx.manifest);
  const other = makeFixture(dir, "b");
  assert.throws(() => repo.register("p1", other.manifest), PublishIdConflictError);
  const changedTime = { ...fx.manifest, timestampUtc: "20261004.091501" };
  assert.throws(() => repo.register("p1", changedTime), PublishIdConflictError);
  repo.close();
});

test("非法清单被拒绝", () => {
  const dir = tempDir("invalid");
  const repo = SnapshotRepository.open(dir);
  const fx = makeFixture(dir, "a");
  assert.throws(
    () => repo.register("p1", { ...fx.manifest, version: "1.4" }),
    InvalidManifestError
  );
  assert.throws(
    () => repo.register("p1", { ...fx.manifest, timestampUtc: "2026-10-04" }),
    InvalidManifestError
  );
  repo.close();
});

test("提交后两个文件可按实际版本逐字节读回，删除源文件不影响", () => {
  const dir = tempDir("commit");
  const repo = SnapshotRepository.open(dir);
  const fx = makeFixture(dir, "a", { pomSize: 2 * 1024 * 1024, jarSize: 5 * 1024 * 1024 });
  const info = repo.register("p1", fx.manifest);
  const result = repo.commit("p1", fx.pomPath, fx.jarPath);
  assert.equal(result.actualVersion, info.actualVersion);
  fs.rmSync(fx.pomPath);
  fs.rmSync(fx.jarPath);
  assert.deepEqual(repo.readFile(info.actualVersion, "pom"), fx.pomContent);
  assert.deepEqual(repo.readFile(info.actualVersion, "jar"), fx.jarContent);
  repo.close();
});

test("重复提交返回原结果，不生成新版本也不重复占用制品", () => {
  const dir = tempDir("recommit");
  const repo = SnapshotRepository.open(dir);
  const fx = makeFixture(dir, "a");
  repo.register("p1", fx.manifest);
  const first = repo.commit("p1", fx.pomPath, fx.jarPath);
  const again = repo.commit("p1", fx.pomPath, fx.jarPath);
  assert.deepEqual(again, first);
  const next = repo.register("p2", fx.manifest);
  assert.equal(next.buildNumber, first.buildNumber + 1);
  repo.close();
});

test("校验和不符的提交失败，发布不可读，可用正确文件重试", () => {
  const dir = tempDir("checksum");
  const repo = SnapshotRepository.open(dir);
  const fx = makeFixture(dir, "a");
  const bad = makeFixture(dir, "bad");
  const info = repo.register("p1", fx.manifest);
  assert.throws(() => repo.commit("p1", bad.pomPath, bad.jarPath), ChecksumMismatchError);
  assert.throws(() => repo.readFile(info.actualVersion, "pom"));
  // 正确文件重试成功
  const result = repo.commit("p1", fx.pomPath, fx.jarPath);
  assert.equal(result.actualVersion, info.actualVersion);
  assert.deepEqual(repo.readFile(info.actualVersion, "jar"), fx.jarContent);
  repo.close();
});

test("提交未知标识报错", () => {
  const dir = tempDir("unknown");
  const repo = SnapshotRepository.open(dir);
  const fx = makeFixture(dir, "a");
  assert.throws(() => repo.commit("nope", fx.pomPath, fx.jarPath), UnknownPublishIdError);
  repo.close();
});

test("当前快照指向已完成发布中构建号最大者，未登记完成的不参与", () => {
  const dir = tempDir("current");
  const repo = SnapshotRepository.open(dir);
  const fx = makeFixture(dir, "a");
  assert.equal(repo.currentSnapshot("com.example", "demo", "1.4-SNAPSHOT"), null);
  const r1 = repo.register("p1", fx.manifest);
  repo.register("p2", fx.manifest); // 只登记不提交
  assert.equal(repo.currentSnapshot("com.example", "demo", "1.4-SNAPSHOT"), null);
  repo.commit("p1", fx.pomPath, fx.jarPath);
  const snap = repo.currentSnapshot("com.example", "demo", "1.4-SNAPSHOT");
  assert.equal(snap?.actualVersion, r1.actualVersion);
  repo.close();
});

test("旧登记晚完成，当前快照不回退，历史版本都可读", () => {
  const dir = tempDir("ordering");
  const repo = SnapshotRepository.open(dir);
  const fx1 = makeFixture(dir, "a");
  const fx2 = makeFixture(dir, "b");
  const r1 = repo.register("p1", fx1.manifest);
  const r2 = repo.register("p2", fx2.manifest);
  // 后登记的先完成
  repo.commit("p2", fx2.pomPath, fx2.jarPath);
  assert.equal(
    repo.currentSnapshot("com.example", "demo", "1.4-SNAPSHOT")?.actualVersion,
    r2.actualVersion
  );
  // 先登记的晚完成，快照不回退
  repo.commit("p1", fx1.pomPath, fx1.jarPath);
  const snap = repo.currentSnapshot("com.example", "demo", "1.4-SNAPSHOT");
  assert.equal(snap?.actualVersion, r2.actualVersion);
  assert.equal(snap?.buildNumber, r2.buildNumber);
  // 两个历史版本都可读
  assert.deepEqual(repo.readFile(r1.actualVersion, "jar"), fx1.jarContent);
  assert.deepEqual(repo.readFile(r2.actualVersion, "jar"), fx2.jarContent);
  repo.close();
});
