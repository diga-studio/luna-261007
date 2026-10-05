import { AsciiStlParser } from "./ascii-parser.js";
import { BinaryStlParser } from "./binary-parser.js";
import { Sha256 } from "./sha256.js";
import { MAX_FILE_BYTES } from "./types.js";
import type { AnalyzeResult, BoundingBox, StlMetadata, Vec3 } from "./types.js";

const MM_PER_INCH = 25.4;

function toInches(min: [number, number, number], max: [number, number, number]): {
  boundingBox: BoundingBox;
  size: Vec3;
} {
  const lo = min.map((v) => v / MM_PER_INCH) as [number, number, number];
  const hi = max.map((v) => v / MM_PER_INCH) as [number, number, number];
  return {
    boundingBox: {
      min: { x: lo[0], y: lo[1], z: lo[2] },
      max: { x: hi[0], y: hi[1], z: hi[2] },
    },
    size: {
      x: (max[0] - min[0]) / MM_PER_INCH,
      y: (max[1] - min[1]) / MM_PER_INCH,
      z: (max[2] - min[2]) / MM_PER_INCH,
    },
  };
}

/**
 * Streaming STL analyzer. Feed bytes via push(), terminate with finish().
 * Both candidate parsers run concurrently over the byte stream; memory use
 * is bounded by a small constant regardless of input size or chunking.
 */
export class StlAnalyzer {
  private readonly maxFileBytes: number;
  private readonly sha = new Sha256();
  private readonly binary = new BinaryStlParser();
  private readonly ascii = new AsciiStlParser();
  private totalBytes = 0;
  private sizeExceeded = false;
  private finished = false;
  private cached: AnalyzeResult | null = null;

  constructor(options?: { maxFileBytes?: number }) {
    this.maxFileBytes = options?.maxFileBytes ?? MAX_FILE_BYTES;
  }

  /** Accept a chunk; caller may reuse the buffer afterwards. */
  push(chunk: Uint8Array): void {
    if (this.finished) {
      throw new Error("StlAnalyzer: push() after finish()");
    }
    if (this.sizeExceeded) return;
    if (this.totalBytes + chunk.length > this.maxFileBytes) {
      this.sizeExceeded = true;
      return;
    }
    this.totalBytes += chunk.length;
    this.sha.update(chunk);
    this.binary.push(chunk);
    this.ascii.push(chunk);
  }

  /** Signal EOF and produce the final result. */
  finish(): AnalyzeResult {
    if (this.cached) return this.cached;
    this.finished = true;
    if (this.sizeExceeded) {
      this.cached = {
        ok: false,
        error: {
          code: "SIZE_LIMIT_EXCEEDED",
          message: `input exceeds ${this.maxFileBytes} bytes`,
        },
      };
      return this.cached;
    }
    this.binary.finish();
    this.ascii.finish();
    const bin = this.binary.result();
    const asc = this.ascii.result();
    const sha256 = this.sha.digestHex();

    let metadata: StlMetadata | null = null;
    if (bin.status === "done") {
      metadata = this.buildMetadata("binary", bin.triangleCount, bin.bboxMin, bin.bboxMax, sha256);
    } else if (asc.status === "done") {
      metadata = this.buildMetadata("ascii", asc.triangleCount, asc.bboxMin, asc.bboxMax, sha256);
    }
    this.cached = metadata
      ? { ok: true, metadata }
      : {
          ok: false,
          error: {
            code: "FORMAT_ERROR",
            message: "input is neither a valid binary nor a valid ASCII STL file",
          },
        };
    return this.cached;
  }

  private buildMetadata(
    format: "binary" | "ascii",
    triangleCount: number,
    bboxMin: [number, number, number],
    bboxMax: [number, number, number],
    sha256: string,
  ): StlMetadata {
    if (triangleCount === 0) {
      return { format, triangleCount, sha256, boundingBox: null, size: null };
    }
    const { boundingBox, size } = toInches(bboxMin, bboxMax);
    return { format, triangleCount, sha256, boundingBox, size };
  }
}
