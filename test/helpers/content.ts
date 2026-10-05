import * as crypto from 'node:crypto';

export function makeContent(seed: string, totalSize: number): Buffer {
  const out = Buffer.alloc(totalSize);
  let offset = 0;
  let counter = 0;
  while (offset < totalSize) {
    const block = crypto
      .createHmac('sha256', seed)
      .update(String(counter))
      .digest();
    const n = Math.min(block.length, totalSize - offset);
    block.copy(out, offset, 0, n);
    offset += n;
    counter += 1;
  }
  return out;
}

export function sha256Hex(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export interface Manifest {
  uploadId: string;
  totalSize: number;
  sha256: string;
  contentFile: string;
  chunkSize: number;
}

export function makeManifest(
  seed: string,
  uploadId: string,
  totalSize: number,
  contentFile: string,
): { manifest: Manifest; content: Buffer } {
  const content = makeContent(seed, totalSize);
  return {
    manifest: {
      uploadId,
      totalSize,
      sha256: sha256Hex(content),
      contentFile,
      chunkSize: 1024 * 1024,
    },
    content,
  };
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffledIndices(count: number, rand: () => number): number[] {
  const arr = Array.from({ length: count }, (_, i) => i);
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
