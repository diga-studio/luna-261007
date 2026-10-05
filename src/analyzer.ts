import { createHash, type Hash } from 'node:crypto';
import { AsciiParser } from './ascii.js';
import { BinaryParser } from './binary.js';
import {
  StlFormatError,
  StlSizeError,
  type BoundingBox,
  type GeometryStats,
  type StlFormat,
  type StlMetadata,
  type Vec3,
} from './types.js';

/** 单文件上限：500 MiB。 */
export const MAX_FILE_SIZE = 500 * 1024 * 1024;

const MM_PER_INCH = 25.4;

/**
 * STL 流式元数据分析器。
 *
 * - push(chunk)：喂入字节；返回后调用方可立即复用该内存（解析器不保留引用）。
 * - finish()：表示 EOF；完整验证通过才返回元数据，否则抛出
 *   StlFormatError / StlSizeError，绝不返回部分元数据。
 *
 * 二进制与 ASCII 解析器并行消费同一份字节流；两者均完整有效时优先二进制。
 * 工作内存与输入大小无关（固定约数百字节，不含调用方 chunk）。
 */
export class StlAnalyzer {
  private binary = new BinaryParser();
  private ascii = new AsciiParser();
  private hash: Hash = createHash('sha256');
  private totalBytes = 0;
  private error: Error | null = null;
  private finished = false;

  push(chunk: Uint8Array): void {
    if (this.finished) throw new Error('push() called after finish()');
    if (this.error) return; // 错误已确定，忽略后续输入
    this.totalBytes += chunk.length;
    if (this.totalBytes > MAX_FILE_SIZE) {
      this.error = new StlSizeError();
      return;
    }
    this.hash.update(chunk);
    this.binary.push(chunk);
    this.ascii.push(chunk);
  }

  finish(): StlMetadata {
    if (this.finished) throw new Error('finish() called twice');
    this.finished = true;
    if (this.error) throw this.error;
    const bin = this.binary.finish();
    if (bin) return this.buildResult('binary', bin);
    const asc = this.ascii.finish();
    if (asc) return this.buildResult('ascii', asc);
    throw new StlFormatError();
  }

  private buildResult(format: StlFormat, stats: GeometryStats): StlMetadata {
    const boundingBox = stats.bboxMm ? scaleBox(stats.bboxMm) : null;
    const dimensions = boundingBox
      ? {
          x: boundingBox.max.x - boundingBox.min.x,
          y: boundingBox.max.y - boundingBox.min.y,
          z: boundingBox.max.z - boundingBox.min.z,
        }
      : null;
    return {
      format,
      triangleCount: stats.triangleCount,
      sha256: this.hash.digest('hex'),
      boundingBox,
      dimensions,
    };
  }
}

function scaleBox(box: BoundingBox): BoundingBox {
  return { min: scaleVec(box.min), max: scaleVec(box.max) };
}

function scaleVec(v: Vec3): Vec3 {
  return { x: v.x / MM_PER_INCH, y: v.y / MM_PER_INCH, z: v.z / MM_PER_INCH };
}
