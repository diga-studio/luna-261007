import { createReadStream } from "node:fs";
import { resolve, sep } from "node:path";
import { MAX_CHUNK_BYTES } from "./types.js";
import type { ContentSource } from "./types.js";

/** 本地文件内容源：rootDir 下按 documentId 相对路径读取，每块 ≤ 64 KiB。 */
export class FileContentSource implements ContentSource {
  readonly #rootDir: string;

  constructor(rootDir: string) {
    this.#rootDir = resolve(rootDir);
  }

  open(documentId: string): AsyncIterable<Uint8Array> {
    const path = resolve(this.#rootDir, documentId);
    if (path !== this.#rootDir && !path.startsWith(this.#rootDir + sep)) {
      throw new Error(`documentId escapes rootDir: ${documentId}`);
    }
    return createReadStream(path, { highWaterMark: MAX_CHUNK_BYTES });
  }
}
