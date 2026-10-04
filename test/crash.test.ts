import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ManifestConflictError, SnapshotRepository } from '../src/index.js';
import {
  makeManifest,
  readAll,
  runCrasher,
  sha256File,
  specOf,
  tempDir,
  writeContentFile,
} from './helpers.js';

function stagingEntries(dir: string): string[] {
  const staging = path.join(dir, 'artifacts', 'staging');
  return fs.existsSync(staging) ? fs.readdirSync(staging) : [];
}

function finalEntries(dir: string): string[] {
  const final = path.join(dir, 'artifacts', 'final');
  return fs.existsSync(final) ? fs.readdirSync(final) : [];
}

test('登记后中断：重开库相同标识返回原实际版本，冲突清单被拒，构建号不复用', () => {
  const dir = tempDir('snap-crash-reg-');
  const manifest = makeManifest();
  const code = runCrasher('register-crash.js', [dir, 'rel-1', JSON.stringify(manifest)]);
  assert.equal(code, 42);

  const repo = SnapshotRepository.open(dir);
  // 相同标识+相同清单 → 原实际版本
  const again = repo.register('rel-1', manifest);
  assert.equal(again.actualVersion, '1.4-20261004.091500-1');
  assert.equal(again.buildNumber, 1);
  // 相同标识+不同清单 → 拒绝
  assert.throws(
    () => repo.register('rel-1', makeManifest({ timestampUtc: '20261212.000000' })),
    ManifestConflictError,
  );
  // 新登记拿到下一个构建号，不复用 1
  const next = repo.register('rel-2', makeManifest());
  assert.equal(next.buildNumber, 2);
  repo.close();
});

test('提交结果未返回时中断（制品已就位）：恢复后成为完整发布，重试收敛', async () => {
  const dir = tempDir('snap-crash-renamed-');
  const src = tempDir('snap-src-');
  const pom = path.join(src, 'a.pom');
  const jar = path.join(src, 'a.jar');
  writeContentFile(pom, 3000, 11);
  writeContentFile(jar, 2 * 1024 * 1024 + 3, 12);
  const manifest = makeManifest({ pom: specOf(pom), jar: specOf(jar) });

  const code = runCrasher('commit-crash.js', [
    dir, 'rel-1', JSON.stringify(manifest), pom, jar, 'renamed',
  ]);
  assert.equal(code, 44);

  const repo = SnapshotRepository.open(dir);
  // 恢复后该次发布完整可见，当前快照指向它
  const cur = repo.currentSnapshot('com.example', 'demo', '1.4-SNAPSHOT');
  assert.equal(cur?.actualVersion, '1.4-20261004.091500-1');
  // 文件逐字节一致
  const jarData = await readAll(repo.readFile('com.example', 'demo', cur!.actualVersion, 'jar'));
  const pomData = await readAll(repo.readFile('com.example', 'demo', cur!.actualVersion, 'pom'));
  assert.equal(jarData.length, fs.statSync(jar).size);
  assert.equal(pomData.length, fs.statSync(pom).size);
  // 无暂存残留，仅一份制品
  assert.deepEqual(stagingEntries(dir), []);
  assert.equal(finalEntries(dir).length, 1);
  // 按原标识重试收敛到同一实际版本，不生成新版本
  const retry = repo.commit('rel-1', pom, jar);
  assert.equal(retry.actualVersion, cur!.actualVersion);
  assert.equal(finalEntries(dir).length, 1);
  repo.close();
});

test('提交在暂存阶段中断：恢复后无半份发布、无制品残留，可重试完成', async () => {
  const dir = tempDir('snap-crash-staged-');
  const src = tempDir('snap-src-');
  const pom = path.join(src, 'a.pom');
  const jar = path.join(src, 'a.jar');
  writeContentFile(pom, 3000, 21);
  writeContentFile(jar, 1024 * 1024, 22);
  const manifest = makeManifest({ pom: specOf(pom), jar: specOf(jar) });

  const code = runCrasher('commit-crash.js', [
    dir, 'rel-1', JSON.stringify(manifest), pom, jar, 'staged',
  ]);
  assert.equal(code, 43);

  const repo = SnapshotRepository.open(dir);
  // 未完成的发布不可见
  assert.equal(repo.currentSnapshot('com.example', 'demo', '1.4-SNAPSHOT'), null);
  // 没有制品残留
  assert.deepEqual(stagingEntries(dir), []);
  assert.deepEqual(finalEntries(dir), []);
  // 登记与构建号保留，重试收敛到同一实际版本
  const reg = repo.register('rel-1', manifest);
  assert.equal(reg.actualVersion, '1.4-20261004.091500-1');
  const res = repo.commit('rel-1', pom, jar);
  assert.equal(res.actualVersion, reg.actualVersion);
  const data = await readAll(repo.readFile('com.example', 'demo', res.actualVersion, 'jar'));
  assert.equal(data.length, fs.statSync(jar).size);
  repo.close();
});

test('恢复再次中断：下一次恢复仍收敛到一致状态', async () => {
  const dir = tempDir('snap-crash-recover-');
  const src = tempDir('snap-src-');
  const pom = path.join(src, 'a.pom');
  const jar = path.join(src, 'a.jar');
  writeContentFile(pom, 2000, 31);
  writeContentFile(jar, 1024 * 1024, 32);
  const manifest = makeManifest({ pom: specOf(pom), jar: specOf(jar) });
  const jarSha = sha256File(jar);

  // rel-1 在 renamed 阶段中断（制品已就位、库未标记）；rel-2 仅登记
  let code = runCrasher('commit-crash.js', [
    dir, 'rel-1', JSON.stringify(manifest), pom, jar, 'renamed',
  ]);
  assert.equal(code, 44);
  {
    const repo = SnapshotRepository.open(dir);
    repo.register('rel-2', makeManifest({ timestampUtc: '20261006.000000' }));
    repo.close();
  }
  // 恢复过程中再次中断
  code = runCrasher('recover-crash.js', [dir]);
  assert.equal(code, 45);
  // 下一次恢复必须得到一致状态
  const repo = SnapshotRepository.open(dir);
  const cur = repo.currentSnapshot('com.example', 'demo', '1.4-SNAPSHOT');
  assert.equal(cur?.actualVersion, '1.4-20261004.091500-1');
  const data = await readAll(repo.readFile('com.example', 'demo', cur!.actualVersion, 'jar'));
  assert.equal(data.length, fs.statSync(jar).size);
  // 已完成文件校验和与输入一致
  const { createHash } = await import('node:crypto');
  assert.equal(createHash('sha256').update(data).digest('hex'), jarSha);
  // 无暂存残留
  assert.deepEqual(stagingEntries(dir), []);
  // rel-2 的登记与构建号保留
  const reg2 = repo.register('rel-2', makeManifest({ timestampUtc: '20261006.000000' }));
  assert.equal(reg2.buildNumber, 2);
  repo.close();
});
