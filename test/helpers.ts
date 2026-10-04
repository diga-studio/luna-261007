import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { Manifest } from '../src/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function sha256File(p: string): string {
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

/** 生成确定性的伪随机内容文件（内容可按 seed 复现）。 */
export function writeContentFile(p: string, size: number, seed: number): void {
  const chunk = Buffer.alloc(1024 * 1024);
  const fd = fs.openSync(p, 'w');
  try {
    let written = 0;
    let block = seed;
    while (written < size) {
      const n = Math.min(chunk.length, size - written);
      for (let i = 0; i < n; i += 8) {
        block = (block * 1103515245 + 12345) >>> 0;
        chunk.writeUInt32LE(block, i);
      }
      fs.writeSync(fd, chunk, 0, n);
      written += n;
    }
  } finally {
    fs.closeSync(fd);
  }
}

export function makeManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    groupId: 'com.example',
    artifactId: 'demo',
    version: '1.4-SNAPSHOT',
    timestampUtc: '20261004.091500',
    pom: { length: 10, sha256: 'a'.repeat(64) },
    jar: { length: 20, sha256: 'b'.repeat(64) },
    ...overrides,
  };
}

/** 依据真实文件构造清单中的文件描述。 */
export function specOf(p: string): { length: number; sha256: string } {
  return { length: fs.statSync(p).size, sha256: sha256File(p) };
}

export async function readAll(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of stream) {
    parts.push(chunk as Buffer);
  }
  return Buffer.concat(parts);
}

/** 运行崩溃模拟子进程，返回退出码。 */
export function runCrasher(script: string, args: string[]): number {
  const scriptPath = path.join(HERE, 'crashers', script);
  const res = spawnSync(process.execPath, [scriptPath, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (res.error) throw res.error;
  return res.status ?? -1;
}
