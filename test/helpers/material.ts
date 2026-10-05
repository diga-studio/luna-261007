import { CHUNK_SIZE } from "../../src/index.js";

/** 崩溃测试用确定性素材：2.5 MiB（3 个分块）。 */
export const CYCLE_UPLOAD_ID = "cycle-upload";
export const CYCLE_TOTAL_CHUNKS = 3;

export function makeCycleMaterial(): Buffer {
  const size = 2 * CHUNK_SIZE + CHUNK_SIZE / 2;
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = (i * 17 + 13) % 239;
  return buf;
}
