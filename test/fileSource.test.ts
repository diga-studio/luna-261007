import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileContentSource, SecureVault } from '../src/index.js';
import { ManualClock, collect, decode } from './helpers.js';

test('FileContentSource 经 SecureVault 流式交付文件内容', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'secure-vault-'));
  try {
    // 构造超过一个块（块大小取 1024 便于测试）的文件。
    const content = 'x'.repeat(1024) + 'y'.repeat(1024) + 'z'.repeat(7);
    const path = join(dir, 'doc.bin');
    await writeFile(path, content);

    const clock = new ManualClock();
    const vault = new SecureVault({
      source: new FileContentSource(1024),
      clock: () => clock.now,
    });
    vault.setGrant('alice', path, { expiresAt: null, maxViews: 1 });
    const token = vault.issueToken('alice', path);

    const chunks = await collect(vault.open('alice', token));
    assert.equal(chunks.length, 3);
    assert.ok(chunks.every((c) => c.length <= 1024));
    assert.equal(decode(chunks), content);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('FileContentSource 默认块不超过 64 KiB', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'secure-vault-'));
  try {
    const path = join(dir, 'big.bin');
    await writeFile(path, Buffer.alloc(64 * 1024 + 1, 1));

    const source = new FileContentSource();
    const sizes: number[] = [];
    for await (const chunk of await source.open(path)) {
      sizes.push(chunk.length);
    }
    assert.deepEqual(sizes, [64 * 1024, 1]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
