import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
  CHUNK_SIZE,
  ChunkConflictError,
  DeclarationMismatchError,
  InvalidChunkError,
  TrainingMaterialStore,
  UploadIncompleteError,
  UploadNotFoundError,
  ValidationError,
} from '../src/index';
import { makeManifest, mulberry32, shuffledIndices } from './helpers/content';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tms-basic-'));
}

function chunkOf(content: Buffer, index: number): Buffer {
  const start = index * CHUNK_SIZE;
  return content.subarray(start, Math.min(start + CHUNK_SIZE, content.length));
}

test('out-of-order chunks with duplicates and conflicts converge to byte-identical artifact', () => {
  const root = tempRoot();
  try {
    const totalSize = 5 * CHUNK_SIZE + 777;
    const contentFile = path.join(root, 'source.bin');
    const { manifest, content } = makeManifest('basic-seed', 'up-basic', totalSize, contentFile);
    fs.writeFileSync(contentFile, content);

    const store = TrainingMaterialStore.open(root);
    store.register({
      uploadId: manifest.uploadId,
      totalSize: manifest.totalSize,
      sha256: manifest.sha256,
    });

    const chunkCount = Math.ceil(totalSize / CHUNK_SIZE);
    const order = shuffledIndices(chunkCount, mulberry32(42));
    for (const index of order) {
      store.receiveChunk(manifest.uploadId, index, chunkOf(content, index));
    }

    // duplicate submissions of identical content are successful no-ops
    for (const index of order) {
      store.receiveChunk(manifest.uploadId, index, chunkOf(content, index));
    }

    // conflicting retries must be rejected and must not corrupt anything
    for (const index of order) {
      const evil = Buffer.alloc(chunkOf(content, index).length, 0xaa);
      assert.throws(
        () => store.receiveChunk(manifest.uploadId, index, evil),
        ChunkConflictError,
      );
    }

    const status = store.getStatus(manifest.uploadId);
    assert.deepEqual(
      status.receivedChunks,
      Array.from({ length: chunkCount }, (_, i) => i),
    );
    assert.equal(status.state, 'uploading');

    const result = store.finalize(manifest.uploadId);
    const produced = fs.readFileSync(result.artifactPath);
    assert.ok(produced.equals(content), 'artifact must be byte-identical');

    // conflicting retries still rejected after completion
    const evil = Buffer.alloc(CHUNK_SIZE, 0xbb);
    assert.throws(
      () => store.receiveChunk(manifest.uploadId, 0, evil),
      ChunkConflictError,
    );
    // identical duplicates still accepted after completion
    store.receiveChunk(manifest.uploadId, 0, chunkOf(content, 0));

    // repeated finalize returns the same single artifact
    const again = store.finalize(manifest.uploadId);
    assert.equal(again.artifactPath, result.artifactPath);
    assert.deepEqual(fs.readdirSync(path.join(root, 'artifacts')), [manifest.uploadId]);
    store.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('repeated registration keeps progress; mismatched declaration rejected', () => {
  const root = tempRoot();
  try {
    const totalSize = 2 * CHUNK_SIZE + 10;
    const { manifest, content } = makeManifest('reg-seed', 'up-reg', totalSize, '');
    const store = TrainingMaterialStore.open(root);
    store.register({
      uploadId: manifest.uploadId,
      totalSize: manifest.totalSize,
      sha256: manifest.sha256,
    });
    store.receiveChunk(manifest.uploadId, 0, chunkOf(content, 0));

    const again = store.register({
      uploadId: manifest.uploadId,
      totalSize: manifest.totalSize,
      sha256: manifest.sha256,
    });
    assert.deepEqual(again.receivedChunks, [0]);

    assert.throws(
      () =>
        store.register({
          uploadId: manifest.uploadId,
          totalSize: manifest.totalSize,
          sha256: '0'.repeat(64),
        }),
      DeclarationMismatchError,
    );
    assert.throws(
      () =>
        store.register({
          uploadId: manifest.uploadId,
          totalSize: manifest.totalSize + 1,
          sha256: manifest.sha256,
        }),
      DeclarationMismatchError,
    );
    // progress still intact after failed registrations
    assert.deepEqual(store.getStatus(manifest.uploadId).receivedChunks, [0]);
    store.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('validation and error cases', () => {
  const root = tempRoot();
  try {
    const store = TrainingMaterialStore.open(root);
    assert.throws(
      () => store.register({ uploadId: 'bad/id', totalSize: 1, sha256: '0'.repeat(64) }),
      ValidationError,
    );
    assert.throws(
      () => store.register({ uploadId: 'x', totalSize: 0, sha256: '0'.repeat(64) }),
      ValidationError,
    );
    assert.throws(
      () =>
        store.register({
          uploadId: 'x',
          totalSize: 100 * 1024 * 1024 + 1,
          sha256: '0'.repeat(64),
        }),
      ValidationError,
    );
    assert.throws(
      () => store.register({ uploadId: 'x', totalSize: 1, sha256: 'zz' }),
      ValidationError,
    );
    assert.throws(() => store.getStatus('nope'), UploadNotFoundError);
    assert.throws(
      () => store.receiveChunk('nope', 0, Buffer.alloc(1)),
      UploadNotFoundError,
    );
    assert.throws(() => store.finalize('nope'), UploadNotFoundError);

    const { manifest, content } = makeManifest('err-seed', 'up-err', CHUNK_SIZE + 5, '');
    store.register({
      uploadId: manifest.uploadId,
      totalSize: manifest.totalSize,
      sha256: manifest.sha256,
    });
    // wrong chunk sizes
    assert.throws(
      () => store.receiveChunk(manifest.uploadId, 0, Buffer.alloc(100)),
      InvalidChunkError,
    );
    assert.throws(
      () => store.receiveChunk(manifest.uploadId, 1, Buffer.alloc(CHUNK_SIZE)),
      InvalidChunkError,
    );
    // index out of range
    assert.throws(
      () => store.receiveChunk(manifest.uploadId, 2, Buffer.alloc(5)),
      InvalidChunkError,
    );
    // incomplete finalize
    store.receiveChunk(manifest.uploadId, 0, chunkOf(content, 0));
    assert.throws(() => store.finalize(manifest.uploadId), UploadIncompleteError);
    // status reflects only fully received chunks
    assert.deepEqual(store.getStatus(manifest.uploadId).receivedChunks, [0]);
    store.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('status survives reopen; single-chunk and exact-multiple sizes work', () => {
  const root = tempRoot();
  try {
    const tiny = makeManifest('tiny', 'up-tiny', 1, '');
    const exact = makeManifest('exact', 'up-exact', 2 * CHUNK_SIZE, '');
    let store = TrainingMaterialStore.open(root);
    for (const m of [tiny.manifest, exact.manifest]) {
      store.register({ uploadId: m.uploadId, totalSize: m.totalSize, sha256: m.sha256 });
    }
    store.receiveChunk('up-tiny', 0, tiny.content);
    store.receiveChunk('up-exact', 0, chunkOf(exact.content, 0));
    store.receiveChunk('up-exact', 1, chunkOf(exact.content, 1));
    store.close();

    store = TrainingMaterialStore.open(root);
    assert.deepEqual(store.getStatus('up-tiny').receivedChunks, [0]);
    assert.deepEqual(store.getStatus('up-exact').receivedChunks, [0, 1]);
    const t = store.finalize('up-tiny');
    assert.ok(fs.readFileSync(t.artifactPath).equals(tiny.content));
    const e = store.finalize('up-exact');
    assert.ok(fs.readFileSync(e.artifactPath).equals(exact.content));
    store.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
