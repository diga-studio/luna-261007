import * as fs from 'node:fs';
import { TrainingMaterialStore } from '../../src/index';
import { Manifest, mulberry32, shuffledIndices } from './content';

function emit(line: string): void {
  fs.writeSync(1, `${line}\n`);
}

function loadManifest(manifestPath: string): Manifest {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Manifest;
}

function main(): void {
  const [mode, rootDir, manifestPath, seedArg] = process.argv.slice(2);
  const manifest = loadManifest(manifestPath);
  const content = fs.readFileSync(manifest.contentFile);
  const store = TrainingMaterialStore.open(rootDir);

  if (mode === 'upload' || mode === 'upload-finalize') {
    store.register({
      uploadId: manifest.uploadId,
      totalSize: manifest.totalSize,
      sha256: manifest.sha256,
    });
    emit('REGISTERED');
    const chunkCount = Math.ceil(manifest.totalSize / manifest.chunkSize);
    const rand = mulberry32(Number(seedArg ?? '1'));
    const order = shuffledIndices(chunkCount, rand);
    for (const index of order) {
      const start = index * manifest.chunkSize;
      const end = Math.min(start + manifest.chunkSize, manifest.totalSize);
      store.receiveChunk(manifest.uploadId, index, content.subarray(start, end));
      emit(`CHUNK_OK ${index}`);
    }
    if (mode === 'upload-finalize') {
      emit('FINALIZE_START');
      const result = store.finalize(manifest.uploadId);
      emit(`FINALIZE_DONE ${result.artifactPath}`);
    }
    store.close();
    emit('EXIT_OK');
    return;
  }

  if (mode === 'finalize') {
    store.register({
      uploadId: manifest.uploadId,
      totalSize: manifest.totalSize,
      sha256: manifest.sha256,
    });
    emit('FINALIZE_START');
    const result = store.finalize(manifest.uploadId);
    emit(`FINALIZE_DONE ${result.artifactPath}`);
    store.close();
    emit('EXIT_OK');
    return;
  }

  if (mode === 'status') {
    const status = store.getStatus(manifest.uploadId);
    emit(`STATUS ${JSON.stringify(status)}`);
    store.close();
    return;
  }

  throw new Error(`unknown mode: ${mode}`);
}

main();
