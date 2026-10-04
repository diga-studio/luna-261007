import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  CommitMismatchError,
  ManifestConflictError,
  SnapshotRepository,
  UnknownReleaseError,
} from '../src/index.js';
import {
  makeManifest,
  readAll,
  sha256File,
  specOf,
  tempDir,
  writeContentFile,
} from './helpers.js';

function setupFiles(dir: string): { pom: string; jar: string } {
  const pom = path.join(dir, 'src.pom');
  const jar = path.join(dir, 'src.jar');
  writeContentFile(pom, 4096, 1);
  writeContentFile(jar, 1024 * 1024 + 7, 2);
  return { pom, jar };
}

test('登记分配实际版本：时间戳替换 SNAPSHOT 并追加构建号', () => {
  const dir = tempDir('snap-basic-');
  const repo = SnapshotRepository.open(dir);
  const r1 = repo.register('rel-1', makeManifest());
  assert.equal(r1.actualVersion, '1.4-20261004.091500-1');
  assert.equal(r1.buildNumber, 1);
  const r2 = repo.register('rel-2', makeManifest({ timestampUtc: '20261005.101112' }));
  assert.equal(r2.actualVersion, '1.4-20261005.101112-2');
  repo.close();
});

test('相同标识+相同清单重复登记返回原实际版本，重开库后仍成立', () => {
  const dir = tempDir('snap-idem-');
  const manifest = makeManifest();
  let repo = SnapshotRepository.open(dir);
  const first = repo.register('rel-x', manifest);
  repo.close();

  repo = SnapshotRepository.open(dir);
  const again = repo.register('rel-x', manifest);
  assert.deepEqual(again, first);
  repo.close();
});

test('相同标识不同清单拒绝重新绑定', () => {
  const dir = tempDir('snap-conflict-');
  const repo = SnapshotRepository.open(dir);
  repo.register('rel-c', makeManifest());
  assert.throws(
    () => repo.register('rel-c', makeManifest({ timestampUtc: '20261111.000000' })),
    ManifestConflictError,
  );
  assert.throws(
    () => repo.register('rel-c', makeManifest({ pom: { length: 11, sha256: 'a'.repeat(64) } })),
    ManifestConflictError,
  );
  repo.close();
});

test('构建号从 1 递增且永不复用（未提交的登记也消耗号码）', () => {
  const dir = tempDir('snap-buildnum-');
  let repo = SnapshotRepository.open(dir);
  const r1 = repo.register('a', makeManifest());
  const r2 = repo.register('b', makeManifest());
  assert.equal(r1.buildNumber, 1);
  assert.equal(r2.buildNumber, 2);
  repo.close();
  // 重开库后继续递增
  repo = SnapshotRepository.open(dir);
  const r3 = repo.register('c', makeManifest());
  assert.equal(r3.buildNumber, 3);
  repo.close();
});

test('提交校验失败不成为可读发布，可用正确文件重试', async () => {
  const dir = tempDir('snap-mismatch-');
  const src = tempDir('snap-src-');
  const { pom, jar } = setupFiles(src);
  const bad = path.join(src, 'bad.jar');
  writeContentFile(bad, 500, 9);

  const repo = SnapshotRepository.open(dir);
  const manifest = makeManifest({ pom: specOf(pom), jar: specOf(jar) });
  const reg = repo.register('rel-m', manifest);

  assert.throws(() => repo.commit('rel-m', pom, bad), CommitMismatchError);
  // 不可读
  assert.equal(repo.currentSnapshot('com.example', 'demo', '1.4-SNAPSHOT'), null);
  assert.throws(
    () => repo.readFile('com.example', 'demo', reg.actualVersion, 'pom'),
    UnknownReleaseError,
  );
  // 正确文件重试成功
  const res = repo.commit('rel-m', pom, jar);
  assert.equal(res.actualVersion, reg.actualVersion);
  const data = await readAll(repo.readFile('com.example', 'demo', reg.actualVersion, 'jar'));
  assert.equal(data.length, fs.statSync(jar).size);
  repo.close();
});

test('提交成功后删除源文件不影响读取，内容逐字节一致', async () => {
  const dir = tempDir('snap-read-');
  const src = tempDir('snap-src-');
  const { pom, jar } = setupFiles(src);
  const pomSha = sha256File(pom);
  const jarSha = sha256File(jar);

  const repo = SnapshotRepository.open(dir);
  const reg = repo.register('rel-r', makeManifest({ pom: specOf(pom), jar: specOf(jar) }));
  repo.commit('rel-r', pom, jar);
  fs.rmSync(pom);
  fs.rmSync(jar);

  const pomData = await readAll(repo.readFile('com.example', 'demo', reg.actualVersion, 'pom'));
  const jarData = await readAll(repo.readFile('com.example', 'demo', reg.actualVersion, 'jar'));
  assert.equal(sha256Of(pomData), pomSha);
  assert.equal(sha256Of(jarData), jarSha);
  repo.close();
});

test('已完成发布的重复提交返回原结果，不额外保留制品', () => {
  const dir = tempDir('snap-dupcommit-');
  const src = tempDir('snap-src-');
  const { pom, jar } = setupFiles(src);
  const repo = SnapshotRepository.open(dir);
  const reg = repo.register('rel-d', makeManifest({ pom: specOf(pom), jar: specOf(jar) }));
  const c1 = repo.commit('rel-d', pom, jar);
  const c2 = repo.commit('rel-d', pom, jar);
  assert.deepEqual(c2, c1);
  const finalRoot = path.join(dir, 'artifacts', 'final');
  assert.equal(fs.readdirSync(finalRoot).length, 1);
  repo.close();
});

test('当前快照取已完成中构建号最大者；旧登记晚完成不回退，历史均可读', async () => {
  const dir = tempDir('snap-order-');
  const src = tempDir('snap-src-');
  const { pom, jar } = setupFiles(src);
  const jar2 = path.join(src, 'src2.jar');
  writeContentFile(jar2, 2048, 77);

  const repo = SnapshotRepository.open(dir);
  const r1 = repo.register('old', makeManifest({ pom: specOf(pom), jar: specOf(jar) }));
  const r2 = repo.register('new', makeManifest({ pom: specOf(pom), jar: specOf(jar2) }));
  assert.equal(r1.buildNumber, 1);
  assert.equal(r2.buildNumber, 2);

  // 只有登记没有完成时不参与选择
  assert.equal(repo.currentSnapshot('com.example', 'demo', '1.4-SNAPSHOT'), null);

  // 后登记的先完成
  repo.commit('new', pom, jar2);
  let cur = repo.currentSnapshot('com.example', 'demo', '1.4-SNAPSHOT');
  assert.equal(cur?.actualVersion, r2.actualVersion);

  // 先登记的晚完成，当前快照不得回退
  repo.commit('old', pom, jar);
  cur = repo.currentSnapshot('com.example', 'demo', '1.4-SNAPSHOT');
  assert.equal(cur?.actualVersion, r2.actualVersion);

  // 两个历史版本都可读
  const d1 = await readAll(repo.readFile('com.example', 'demo', r1.actualVersion, 'jar'));
  const d2 = await readAll(repo.readFile('com.example', 'demo', r2.actualVersion, 'jar'));
  assert.equal(sha256Of(d1), sha256File(jar));
  assert.equal(sha256Of(d2), sha256File(jar2));
  repo.close();
});

test('未知发布标识提交报错', () => {
  const dir = tempDir('snap-unknown-');
  const repo = SnapshotRepository.open(dir);
  assert.throws(() => repo.commit('nope', 'a', 'b'), UnknownReleaseError);
  repo.close();
});

function sha256Of(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}
