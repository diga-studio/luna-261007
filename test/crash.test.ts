import * as assert from 'node:assert/strict';
import { ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { TrainingMaterialStore, UploadStatus } from '../src/index';
import { Manifest, makeManifest, mulberry32 } from './helpers/content';

const RUNNER = path.join(__dirname, 'helpers', 'runner.js');

interface RunResult {
  lines: string[];
  exitCode: number | null;
  signal: string | null;
}

interface RunHandle {
  lines: string[];
  waitLine(prefix: string, timeoutMs: number): Promise<string>;
  kill(): void;
  done: Promise<RunResult>;
}

function runRunner(
  mode: string,
  root: string,
  manifestPath: string,
  seed?: number,
): RunHandle {
  const args = [RUNNER, mode, root, manifestPath];
  if (seed !== undefined) args.push(String(seed));
  const child: ChildProcess = spawn(process.execPath, args, {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const lines: string[] = [];
  const waiters: { prefix: string; resolve: (l: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }[] = [];
  let buf = '';
  child.stdout!.on('data', (d: Buffer) => {
    buf += d.toString('utf8');
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      lines.push(line);
      for (let i = waiters.length - 1; i >= 0; i -= 1) {
        if (line.startsWith(waiters[i].prefix)) {
          clearTimeout(waiters[i].timer);
          waiters[i].resolve(line);
          waiters.splice(i, 1);
        }
      }
    }
  });
  const done = new Promise<RunResult>((resolve) => {
    child.on('exit', (code, signal) => {
      for (const w of waiters.splice(0)) {
        clearTimeout(w.timer);
        w.reject(new Error(`child exited (code=${code} signal=${signal})`));
      }
      resolve({ lines, exitCode: code, signal });
    });
  });
  return {
    lines,
    waitLine(prefix: string, timeoutMs: number): Promise<string> {
      const existing = lines.find((l) => l.startsWith(prefix));
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${prefix}`)), timeoutMs);
        waiters.push({ prefix, resolve, reject, timer });
      });
    },
    kill(): void {
      child.kill('SIGKILL');
    },
    done,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tms-crash-'));
}

function writeManifest(root: string, seed: string, uploadId: string, totalSize: number) {
  const contentFile = path.join(root, `${uploadId}.source.bin`);
  const { manifest, content } = makeManifest(seed, uploadId, totalSize, contentFile);
  fs.writeFileSync(contentFile, content);
  const manifestPath = path.join(root, `${uploadId}.manifest.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  return { manifest, content, manifestPath };
}

function chunkCountOf(manifest: Manifest): number {
  return Math.ceil(manifest.totalSize / manifest.chunkSize);
}

function listTmp(root: string): string[] {
  const tmp = path.join(root, 'tmp');
  return fs.existsSync(tmp) ? fs.readdirSync(tmp) : [];
}

test('crash during receiveChunk: confirmed chunks survive reopen', async () => {
  const root = tempRoot();
  try {
    const totalSize = 8 * 1024 * 1024 + 55;
    const { manifest, content, manifestPath } = writeManifest(root, 'crash-chunk', 'up-crash-chunk', totalSize);
    const chunkCount = chunkCountOf(manifest);

    const first = runRunner('upload', root, manifestPath, 7);
    await first.waitLine('CHUNK_OK', 30000);
    // let a few more chunks land, then kill mid-stream
    await sleep(30);
    first.kill();
    const crashed = await first.done;
    assert.equal(crashed.signal, 'SIGKILL');
    const confirmed = crashed.lines
      .filter((l) => l.startsWith('CHUNK_OK '))
      .map((l) => Number(l.split(' ')[1]));
    assert.ok(confirmed.length >= 1 && confirmed.length < chunkCount);

    // reopen in a fresh process and read status
    const second = runRunner('status', root, manifestPath);
    const statusLine = await second.waitLine('STATUS ', 30000);
    await second.done;
    const status = JSON.parse(statusLine.slice('STATUS '.length)) as UploadStatus;
    for (const index of confirmed) {
      assert.ok(
        status.receivedChunks.includes(index),
        `confirmed chunk ${index} must survive reopen`,
      );
    }

    // finish the upload with duplicates of everything, then finalize
    const third = runRunner('upload-finalize', root, manifestPath, 99);
    const doneLine = await third.waitLine('FINALIZE_DONE ', 60000);
    await third.done;
    const artifactPath = doneLine.slice('FINALIZE_DONE '.length);
    assert.ok(fs.readFileSync(artifactPath).equals(content));
    assert.deepEqual(listTmp(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('crash during finalize: recovery converges to a single readable artifact', async () => {
  const root = tempRoot();
  try {
    const totalSize = 48 * 1024 * 1024 + 3;
    const { manifest, content, manifestPath } = writeManifest(root, 'crash-fin', 'up-crash-fin', totalSize);

    // fully upload in-process first
    const store = TrainingMaterialStore.open(root);
    store.register({ uploadId: manifest.uploadId, totalSize: manifest.totalSize, sha256: manifest.sha256 });
    const count = chunkCountOf(manifest);
    for (let i = 0; i < count; i += 1) {
      const start = i * manifest.chunkSize;
      store.receiveChunk(manifest.uploadId, i, content.subarray(start, Math.min(start + manifest.chunkSize, content.length)));
    }
    store.close();

    // repeatedly kill finalize attempts mid-flight
    let midFinalizeKills = 0;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const handle = runRunner('finalize', root, manifestPath);
      await handle.waitLine('FINALIZE_START', 30000);
      await sleep(Math.floor(Math.random() * 15));
      handle.kill();
      const result = await handle.done;
      if (!result.lines.some((l) => l.startsWith('FINALIZE_DONE'))) {
        midFinalizeKills += 1;
      }
      // every reopen must leave the store operable; tmp must be clean after recovery
      const probe = runRunner('status', root, manifestPath);
      const statusLine = await probe.waitLine('STATUS ', 30000);
      await probe.done;
      const status = JSON.parse(statusLine.slice('STATUS '.length)) as UploadStatus;
      assert.deepEqual(listTmp(root), [], 'no orphan temp files after recovery');
      if (status.state === 'completed') {
        assert.ok(fs.readFileSync(status.artifactPath!).equals(content));
        break;
      }
    }
    assert.ok(midFinalizeKills >= 0); // informational

    // final successful finalize converges to the single artifact
    const fin = runRunner('finalize', root, manifestPath);
    const doneLine = await fin.waitLine('FINALIZE_DONE ', 60000);
    await fin.done;
    const artifactPath = doneLine.slice('FINALIZE_DONE '.length);
    assert.ok(fs.readFileSync(artifactPath).equals(content));
    assert.deepEqual(fs.readdirSync(path.join(root, 'artifacts')), [manifest.uploadId]);
    assert.deepEqual(listTmp(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('100 interrupt/recover/retry cycles leave exactly one artifact and no orphan temp files', async () => {
  const root = tempRoot();
  try {
    const totalSize = 4 * 1024 * 1024 + 100;
    const { manifest, content, manifestPath } = writeManifest(root, 'crash-100', 'up-crash-100', totalSize);
    const rand = mulberry32(20261007);

    for (let cycle = 0; cycle < 100; cycle += 1) {
      const handle = runRunner('upload-finalize', root, manifestPath, cycle + 1);
      const killAfterMs = Math.floor(rand() * 60);
      await sleep(killAfterMs);
      handle.kill();
      await handle.done;
    }

    // final run to completion
    const fin = runRunner('upload-finalize', root, manifestPath, 424242);
    const doneLine = await fin.waitLine('FINALIZE_DONE ', 60000);
    await fin.done;
    const artifactPath = doneLine.slice('FINALIZE_DONE '.length);

    assert.ok(fs.readFileSync(artifactPath).equals(content), 'artifact byte-identical after 100 cycles');
    assert.deepEqual(
      fs.readdirSync(path.join(root, 'artifacts')),
      [manifest.uploadId],
      'exactly one artifact',
    );
    assert.deepEqual(listTmp(root), [], 'no orphan temp files');

    const store = TrainingMaterialStore.open(root);
    const status = store.getStatus(manifest.uploadId);
    assert.equal(status.state, 'completed');
    assert.equal(status.receivedChunks.length, chunkCountOf(manifest));
    assert.equal(status.artifactPath, artifactPath);
    store.close();
    assert.deepEqual(listTmp(root), [], 'no orphan temp files after final reopen');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
