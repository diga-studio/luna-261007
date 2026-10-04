import { strictEqual, deepStrictEqual, ok, throws } from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { QuarantineExecutor } from '../src/index.js';

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

interface Fixture {
  root: string;
  originalRoot: string;
  quarantineRoot: string;
  executor: QuarantineExecutor;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'sentinel-'));
  const originalRoot = join(root, 'original');
  const quarantineRoot = join(root, 'quarantine');
  mkdirSync(originalRoot, { recursive: true });
  const executor = new QuarantineExecutor({
    originalRoot,
    quarantineRoot,
    databasePath: join(root, 'metadata.sqlite'),
  });
  return {
    root,
    originalRoot,
    quarantineRoot,
    executor,
    cleanup: () => {
      executor.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function quarantineContentFiles(quarantineRoot: string): string[] {
  const contentDir = join(quarantineRoot, 'content');
  return existsSync(contentDir) ? readdirSync(contentDir) : [];
}

test('quarantine then restore round-trips bytes; replayed quarantine does not move the file again', () => {
  const fx = makeFixture();
  try {
    const content = randomBytes(4096);
    const digest = sha256Hex(content);
    writeFileSync(join(fx.originalRoot, 'report.bin'), content);

    const q1 = fx.executor.quarantine('cmd-q-1', 'report.bin', digest);
    deepStrictEqual(q1, { status: 'quarantined', quarantineId: 'cmd-q-1' });
    strictEqual(existsSync(join(fx.originalRoot, 'report.bin')), false);
    strictEqual(quarantineContentFiles(fx.quarantineRoot).length, 1);

    const r1 = fx.executor.restore('cmd-r-1', 'cmd-q-1');
    deepStrictEqual(r1, { status: 'restored' });
    deepStrictEqual(readFileSync(join(fx.originalRoot, 'report.bin')), content);
    strictEqual(quarantineContentFiles(fx.quarantineRoot).length, 0);

    // Replay the old quarantine command: must return the first result and
    // must not move the restored file away again.
    const q1Replay = fx.executor.quarantine('cmd-q-1', 'report.bin', digest);
    deepStrictEqual(q1Replay, { status: 'quarantined', quarantineId: 'cmd-q-1' });
    strictEqual(existsSync(join(fx.originalRoot, 'report.bin')), true);
    deepStrictEqual(readFileSync(join(fx.originalRoot, 'report.bin')), content);
    strictEqual(quarantineContentFiles(fx.quarantineRoot).length, 0);

    // Replay the restore command as well.
    const r1Replay = fx.executor.restore('cmd-r-1', 'cmd-q-1');
    deepStrictEqual(r1Replay, { status: 'restored' });
    deepStrictEqual(readFileSync(join(fx.originalRoot, 'report.bin')), content);
  } finally {
    fx.cleanup();
  }
});

test('restore conflict on identical-bytes occupant; conflict result is stable across retries', () => {
  const fx = makeFixture();
  try {
    const content = randomBytes(2048);
    const digest = sha256Hex(content);
    writeFileSync(join(fx.originalRoot, 'data.bin'), content);

    const q = fx.executor.quarantine('cmd-q-2', 'data.bin', digest);
    deepStrictEqual(q, { status: 'quarantined', quarantineId: 'cmd-q-2' });

    // A new file with the exact same bytes now occupies the original path.
    writeFileSync(join(fx.originalRoot, 'data.bin'), content);

    const r1 = fx.executor.restore('cmd-r-2', 'cmd-q-2');
    deepStrictEqual(r1, { status: 'conflict' });
    // Quarantined content is preserved.
    strictEqual(quarantineContentFiles(fx.quarantineRoot).length, 1);

    // The path becomes free afterwards: the recorded conflict must not change.
    rmSync(join(fx.originalRoot, 'data.bin'));
    const r1Retry = fx.executor.restore('cmd-r-2', 'cmd-q-2');
    deepStrictEqual(r1Retry, { status: 'conflict' });
    strictEqual(existsSync(join(fx.originalRoot, 'data.bin')), false);
    strictEqual(quarantineContentFiles(fx.quarantineRoot).length, 1);

    // A different restore command for the same entry may now succeed.
    const r2 = fx.executor.restore('cmd-r-3', 'cmd-q-2');
    deepStrictEqual(r2, { status: 'restored' });
    deepStrictEqual(readFileSync(join(fx.originalRoot, 'data.bin')), content);
    strictEqual(quarantineContentFiles(fx.quarantineRoot).length, 0);
  } finally {
    fx.cleanup();
  }
});

test('sha256 mismatch leaves the original file untouched', () => {
  const fx = makeFixture();
  try {
    const content = randomBytes(1024);
    writeFileSync(join(fx.originalRoot, 'a.bin'), content);
    const wrongDigest = sha256Hex(randomBytes(16));

    const q = fx.executor.quarantine('cmd-q-3', 'a.bin', wrongDigest);
    deepStrictEqual(q, { status: 'sha256_mismatch' });
    deepStrictEqual(readFileSync(join(fx.originalRoot, 'a.bin')), content);
    strictEqual(quarantineContentFiles(fx.quarantineRoot).length, 0);

    // Retry returns the recorded mismatch without touching the file.
    deepStrictEqual(fx.executor.quarantine('cmd-q-3', 'a.bin', wrongDigest), {
      status: 'sha256_mismatch',
    });
    deepStrictEqual(readFileSync(join(fx.originalRoot, 'a.bin')), content);
  } finally {
    fx.cleanup();
  }
});

test('missing file and unknown quarantine entry', () => {
  const fx = makeFixture();
  try {
    deepStrictEqual(fx.executor.quarantine('cmd-q-4', 'nope.bin', '0'.repeat(64)), {
      status: 'not_found',
    });
    deepStrictEqual(fx.executor.restore('cmd-r-4', 'no-such-quarantine'), {
      status: 'quarantine_not_found',
    });
  } finally {
    fx.cleanup();
  }
});

test('nested relative paths are quarantined and restored at the same location', () => {
  const fx = makeFixture();
  try {
    const content = randomBytes(512);
    const digest = sha256Hex(content);
    mkdirSync(join(fx.originalRoot, 'sub', 'dir'), { recursive: true });
    writeFileSync(join(fx.originalRoot, 'sub', 'dir', 'f.bin'), content);

    deepStrictEqual(fx.executor.quarantine('cmd-q-5', 'sub/dir/f.bin', digest), {
      status: 'quarantined',
      quarantineId: 'cmd-q-5',
    });
    strictEqual(existsSync(join(fx.originalRoot, 'sub', 'dir', 'f.bin')), false);

    deepStrictEqual(fx.executor.restore('cmd-r-5', 'cmd-q-5'), { status: 'restored' });
    deepStrictEqual(readFileSync(join(fx.originalRoot, 'sub', 'dir', 'f.bin')), content);
  } finally {
    fx.cleanup();
  }
});

test('commandId reuse with different parameters is rejected', () => {
  const fx = makeFixture();
  try {
    const content = randomBytes(128);
    const digest = sha256Hex(content);
    writeFileSync(join(fx.originalRoot, 'b.bin'), content);
    fx.executor.quarantine('cmd-q-6', 'b.bin', digest);

    throws(() => fx.executor.quarantine('cmd-q-6', 'b.bin', '0'.repeat(64)));
    throws(() => fx.executor.restore('cmd-q-6', 'cmd-q-6'));
  } finally {
    fx.cleanup();
  }
});

test('metadata survives executor restart and replay still works', () => {
  const fx = makeFixture();
  try {
    const content = randomBytes(256);
    const digest = sha256Hex(content);
    writeFileSync(join(fx.originalRoot, 'c.bin'), content);
    fx.executor.quarantine('cmd-q-7', 'c.bin', digest);
    fx.executor.close();

    const reopened = new QuarantineExecutor({
      originalRoot: fx.originalRoot,
      quarantineRoot: fx.quarantineRoot,
      databasePath: join(fx.root, 'metadata.sqlite'),
    });
    try {
      deepStrictEqual(reopened.quarantine('cmd-q-7', 'c.bin', digest), {
        status: 'quarantined',
        quarantineId: 'cmd-q-7',
      });
      deepStrictEqual(reopened.restore('cmd-r-7', 'cmd-q-7'), { status: 'restored' });
      deepStrictEqual(readFileSync(join(fx.originalRoot, 'c.bin')), content);
      strictEqual(quarantineContentFiles(fx.quarantineRoot).length, 0);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('paths escaping the original root are rejected', () => {
  const fx = makeFixture();
  try {
    throws(() => fx.executor.quarantine('cmd-q-8', '../outside.bin', '0'.repeat(64)));
    throws(() => fx.executor.quarantine('cmd-q-9', '/abs/path.bin', '0'.repeat(64)));
  } finally {
    fx.cleanup();
  }
});
