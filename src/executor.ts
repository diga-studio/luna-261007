import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { MetadataStore } from './metadataStore.js';
import type { ExecutorOptions, QuarantineResult, RestoreResult } from './types.js';

function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export class QuarantineExecutor {
  private readonly originalRoot: string;
  private readonly quarantineRoot: string;
  private readonly store: MetadataStore;

  constructor(options: ExecutorOptions) {
    this.originalRoot = resolve(options.originalRoot);
    this.quarantineRoot = resolve(options.quarantineRoot);
    mkdirSync(this.originalRoot, { recursive: true });
    mkdirSync(this.contentDir, { recursive: true });
    this.store = new MetadataStore(options.databasePath);
  }

  quarantine(commandId: string, relativePath: string, expectedSha256: string): QuarantineResult {
    const paramsJson = JSON.stringify({ relativePath, expectedSha256 });
    const replayed = this.replayResult(commandId, 'quarantine', paramsJson);
    if (replayed) return replayed.result as QuarantineResult;

    const result = this.doQuarantine(commandId, relativePath, expectedSha256);
    this.store.recordCommand(commandId, 'quarantine', paramsJson, { op: 'quarantine', result });
    return result;
  }

  restore(commandId: string, quarantineId: string): RestoreResult {
    const paramsJson = JSON.stringify({ quarantineId });
    const replayed = this.replayResult(commandId, 'restore', paramsJson);
    if (replayed) return replayed.result as RestoreResult;

    const result = this.doRestore(quarantineId);
    this.store.recordCommand(commandId, 'restore', paramsJson, { op: 'restore', result });
    return result;
  }

  close(): void {
    this.store.close();
  }

  private get contentDir(): string {
    return join(this.quarantineRoot, 'content');
  }

  private replayResult(commandId: string, op: string, paramsJson: string) {
    const stored = this.store.getCommand(commandId);
    if (!stored) return null;
    const storedParams = this.store.getCommandParams(commandId);
    if (stored.op !== op || storedParams !== paramsJson) {
      throw new Error(`commandId "${commandId}" was already used with different parameters`);
    }
    return stored;
  }

  private doQuarantine(commandId: string, relativePath: string, expectedSha256: string): QuarantineResult {
    const target = this.resolveInOriginalRoot(relativePath);
    if (!existsSync(target)) {
      return { status: 'not_found' };
    }
    const actualSha256 = sha256Hex(readFileSync(target));
    if (actualSha256 !== expectedSha256.toLowerCase()) {
      return { status: 'sha256_mismatch' };
    }
    const quarantineId = commandId;
    const quarantineFile = this.quarantineFilePath(quarantineId);
    renameSync(target, quarantineFile);
    this.store.insertQuarantine({
      quarantineId,
      relativePath: normalize(relativePath),
      sha256: actualSha256,
      state: 'held',
    });
    return { status: 'quarantined', quarantineId };
  }

  private doRestore(quarantineId: string): RestoreResult {
    const record = this.store.getQuarantine(quarantineId);
    if (!record) {
      return { status: 'quarantine_not_found' };
    }
    if (record.state !== 'held') {
      return { status: 'already_restored' };
    }
    const target = this.resolveInOriginalRoot(record.relativePath);
    if (existsSync(target)) {
      return { status: 'conflict' };
    }
    const quarantineFile = this.quarantineFilePath(quarantineId);
    mkdirSync(dirname(target), { recursive: true });
    renameSync(quarantineFile, target);
    this.store.markRestored(quarantineId);
    return { status: 'restored' };
  }

  private quarantineFilePath(quarantineId: string): string {
    return join(this.contentDir, sha256Hex(quarantineId));
  }

  private resolveInOriginalRoot(relativePath: string): string {
    if (isAbsolute(relativePath)) {
      throw new Error(`relativePath must be relative: "${relativePath}"`);
    }
    const normalized = normalize(relativePath);
    const abs = resolve(this.originalRoot, normalized);
    if (abs !== this.originalRoot && !abs.startsWith(this.originalRoot + sep)) {
      throw new Error(`relativePath escapes the original root: "${relativePath}"`);
    }
    return abs;
  }
}
