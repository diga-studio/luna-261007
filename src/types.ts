export type StlFormat = "binary" | "ascii";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface BoundingBox {
  min: Vec3;
  max: Vec3;
}

export interface StlMetadata {
  format: StlFormat;
  triangleCount: number;
  sha256: string;
  /** Bounding box in inches, null when triangleCount === 0 */
  boundingBox: BoundingBox | null;
  /** Axis sizes in inches, null when triangleCount === 0 */
  size: Vec3 | null;
}

export type AnalyzeResult =
  | { ok: true; metadata: StlMetadata }
  | { ok: false; error: StlError };

export type StlErrorCode =
  | "FORMAT_ERROR"
  | "SIZE_LIMIT_EXCEEDED"
  | "PUSH_AFTER_FINISH";

export interface StlError {
  code: StlErrorCode;
  message: string;
}

export const MAX_FILE_BYTES = 500 * 1024 * 1024; // 500 MiB
