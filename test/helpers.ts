import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodePng, encodePng } from '../src/png';

/** Deterministic opaque PNG where every pixel differs per (seed, position). */
export function makePng(width: number, height: number, seed: number): Buffer {
  const data = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    data[i * 3] = (seed * 31 + i * 7) % 256;
    data[i * 3 + 1] = (seed * 17 + i * 11) % 256;
    data[i * 3 + 2] = (seed * 13 + i * 3) % 256;
  }
  return encodePng(width, height, data);
}

/** Copy of `base` (a PNG made by makePng) with `changedPixels` pixels altered. */
export function alterPixels(base: Buffer, width: number, height: number, changedPixels: number): Buffer {
  const img = decodePng(base);
  const data = Buffer.from(img.data);
  for (let p = 0; p < changedPixels && p < width * height; p++) {
    data[p * 3] = (data[p * 3] + 1) % 256;
    data[p * 3 + 1] = (data[p * 3 + 1] + 2) % 256;
    data[p * 3 + 2] = (data[p * 3 + 2] + 3) % 256;
  }
  return encodePng(width, height, data);
}

export function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'vr-lib-test-'));
}

export function removeTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** On-disk path of a content-addressed stored image. */
export function storedImagePath(dir: string, png: Buffer): string {
  const hash = createHash('sha256');
  hash.update(png);
  return join(dir, 'images', `${hash.digest('hex')}.png`);
}

export function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
