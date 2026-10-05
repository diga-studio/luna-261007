import { open } from 'node:fs/promises';
import type { ContentSource } from './types.js';

export const DEFAULT_CHUNK_SIZE = 64 * 1024;

/** 本地文件内容源：documentId 即文件路径，按固定块大小读取。 */
export class FileContentSource implements ContentSource {
  private readonly chunkSize: number;

  constructor(chunkSize: number = DEFAULT_CHUNK_SIZE) {
    if (!Number.isInteger(chunkSize) || chunkSize <= 0 || chunkSize > DEFAULT_CHUNK_SIZE) {
      throw new RangeError('chunkSize must be an integer in 1..65536');
    }
    this.chunkSize = chunkSize;
  }

  async open(documentId: string): Promise<AsyncIterable<Uint8Array>> {
    const handle = await open(documentId, 'r');
    const chunkSize = this.chunkSize;
    return {
      async *[Symbol.asyncIterator]() {
        try {
          const buffer = Buffer.allocUnsafe(chunkSize);
          for (;;) {
            const { bytesRead } = await handle.read(buffer, 0, chunkSize, null);
            if (bytesRead === 0) {
              return;
            }
            yield new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead).slice();
          }
        } finally {
          await handle.close();
        }
      },
    };
  }
}
