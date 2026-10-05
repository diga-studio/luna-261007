/**
 * Streaming parser for binary STL:
 *   80-byte header, uint32 LE triangle count, then count * 50-byte records.
 * Each record: 3 normal floats, 9 vertex floats (all LE Float32, finite),
 * 2 attribute bytes. Trailing bytes after the last record are invalid.
 *
 * Memory: fixed 84-byte prefix buffer + 50-byte record staging buffer.
 */
export type BinaryParseStatus = "pending" | "invalid" | "done";

export interface BinaryParseResult {
  status: BinaryParseStatus;
  triangleCount: number;
  bboxMin: [number, number, number];
  bboxMax: [number, number, number];
}

const HEADER_LEN = 80;
const COUNT_LEN = 4;
const RECORD_LEN = 50;
const PREFIX_LEN = HEADER_LEN + COUNT_LEN;

export class BinaryStlParser {
  private status: BinaryParseStatus = "pending";
  private readonly prefix = new Uint8Array(PREFIX_LEN);
  private prefixLen = 0;
  private readonly record = new Uint8Array(RECORD_LEN);
  private recordLen = 0;
  private readonly recordView = new DataView(this.record.buffer);
  private readonly values = new Float64Array(12);
  private expected = 0;
  private seen = 0;
  private readonly min: [number, number, number] = [Infinity, Infinity, Infinity];
  private readonly max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  push(chunk: Uint8Array): void {
    if (this.status !== "pending") return;
    let offset = 0;

    if (this.prefixLen < PREFIX_LEN) {
      const take = Math.min(PREFIX_LEN - this.prefixLen, chunk.length);
      this.prefix.set(chunk.subarray(0, take), this.prefixLen);
      this.prefixLen += take;
      offset += take;
      if (this.prefixLen === PREFIX_LEN) {
        this.expected = new DataView(this.prefix.buffer).getUint32(HEADER_LEN, true);
      }
    }

    while (offset < chunk.length && this.status === "pending") {
      if (this.seen === this.expected) {
        // All records consumed; any further byte is a trailing byte.
        this.status = "invalid";
        return;
      }
      const take = Math.min(RECORD_LEN - this.recordLen, chunk.length - offset);
      this.record.set(chunk.subarray(offset, offset + take), this.recordLen);
      this.recordLen += take;
      offset += take;
      if (this.recordLen === RECORD_LEN) {
        this.consumeRecord();
        this.recordLen = 0;
      }
    }
  }

  private consumeRecord(): void {
    const view = this.recordView;
    const values = this.values;
    for (let i = 0; i < 12; i++) {
      const v = view.getFloat32(i * 4, true);
      if (!Number.isFinite(v)) {
        this.status = "invalid";
        return;
      }
      values[i] = v;
    }
    for (let vert = 0; vert < 3; vert++) {
      for (let axis = 0; axis < 3; axis++) {
        const v = values[3 + vert * 3 + axis]!;
        if (v < this.min[axis]!) this.min[axis] = v;
        if (v > this.max[axis]!) this.max[axis] = v;
      }
    }
    this.seen++;
  }

  finish(): void {
    if (this.status !== "pending") return;
    const prefixComplete = this.prefixLen === PREFIX_LEN;
    const recordsComplete = prefixComplete && this.seen === this.expected && this.recordLen === 0;
    this.status = recordsComplete ? "done" : "invalid";
  }

  result(): BinaryParseResult {
    return {
      status: this.status,
      triangleCount: this.seen,
      bboxMin: [this.min[0], this.min[1], this.min[2]],
      bboxMax: [this.max[0], this.max[1], this.max[2]],
    };
  }
}
