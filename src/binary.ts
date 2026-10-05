import type { BoundingBox, GeometryStats } from './types.js';

const PREFIX_LEN = 84; // 80 字节头部 + 4 字节三角形数
const RECORD_LEN = 50; // 12 个 Float32 + 2 字节属性

/**
 * 二进制 STL 增量解析器。
 * 结构：80 字节任意头部 + 4 字节 LE 无符号三角形数 + N 条 50 字节记录。
 * EOF 必须恰好对齐；缺失记录或尾随字节均无效。12 个分量必须有限。
 * 内部缓冲固定为 84 + 50 字节，与输入大小无关。
 */
export class BinaryParser {
  private prefix = new Uint8Array(PREFIX_LEN);
  private prefixLen = 0;
  private record = new Uint8Array(RECORD_LEN);
  private recordLen = 0;
  private recordsRemaining = -1; // -1 表示尚未读到三角形数
  private failed = false;

  private triCount = 0;
  private min = [Infinity, Infinity, Infinity];
  private max = [-Infinity, -Infinity, -Infinity];

  push(chunk: Uint8Array): void {
    if (this.failed) return;
    let offset = 0;
    if (this.recordsRemaining < 0) {
      const take = Math.min(PREFIX_LEN - this.prefixLen, chunk.length);
      this.prefix.set(chunk.subarray(0, take), this.prefixLen);
      this.prefixLen += take;
      offset += take;
      if (this.prefixLen < PREFIX_LEN) return;
      const view = new DataView(this.prefix.buffer, this.prefix.byteOffset, PREFIX_LEN);
      const count = view.getUint32(80, true);
      this.triCount = count;
      this.recordsRemaining = count;
    }
    while (offset < chunk.length) {
      if (this.recordsRemaining === 0) {
        // 期望记录已全部消费，任何尾随字节均无效
        this.failed = true;
        return;
      }
      const take = Math.min(RECORD_LEN - this.recordLen, chunk.length - offset);
      this.record.set(chunk.subarray(offset, offset + take), this.recordLen);
      this.recordLen += take;
      offset += take;
      if (this.recordLen === RECORD_LEN) {
        this.consumeRecord();
        if (this.failed) return;
        this.recordLen = 0;
        this.recordsRemaining -= 1;
      }
    }
  }

  finish(): GeometryStats | null {
    if (this.failed) return null;
    if (this.recordsRemaining !== 0) return null; // 头部未齐或记录缺失
    return { triangleCount: this.triCount, bboxMm: this.bbox() };
  }

  get dead(): boolean {
    return this.failed;
  }

  private consumeRecord(): void {
    const view = new DataView(this.record.buffer, this.record.byteOffset, RECORD_LEN);
    const values: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const v = view.getFloat32(i * 4, true);
      if (!Number.isFinite(v)) {
        this.failed = true;
        return;
      }
      values.push(v);
    }
    // 顶点为分量 3..11（法线 0..2 不进包围盒）
    for (let i = 3; i < 12; i += 3) {
      for (let axis = 0; axis < 3; axis += 1) {
        const v = values[i + axis]!;
        if (v < this.min[axis]!) this.min[axis] = v;
        if (v > this.max[axis]!) this.max[axis] = v;
      }
    }
  }

  private bbox(): BoundingBox | null {
    if (this.triCount === 0) return null;
    return {
      min: { x: this.min[0]!, y: this.min[1]!, z: this.min[2]! },
      max: { x: this.max[0]!, y: this.max[1]!, z: this.max[2]! },
    };
  }
}
