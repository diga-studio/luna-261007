/** STL 文件格式。 */
export type StlFormat = 'binary' | 'ascii';

/** 三维向量（英寸）。 */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** 轴对齐包围盒（英寸）。 */
export interface BoundingBox {
  min: Vec3;
  max: Vec3;
}

/** 分析成功结果。 */
export interface StlMetadata {
  format: StlFormat;
  triangleCount: number;
  /** 原始字节流的 SHA-256（hex）。 */
  sha256: string;
  /** 英寸包围盒；零三角形时为 null。 */
  boundingBox: BoundingBox | null;
  /** 三轴尺寸（英寸）；零三角形时为 null。 */
  dimensions: Vec3 | null;
}

/** 格式错误：两种格式均无法完整有效解析。 */
export class StlFormatError extends Error {
  constructor(message = 'invalid STL: neither binary nor ASCII form is valid') {
    super(message);
    this.name = 'StlFormatError';
  }
}

/** 大小错误：输入超过单文件上限。 */
export class StlSizeError extends Error {
  constructor(message = 'input exceeds the 500 MiB size limit') {
    super(message);
    this.name = 'StlSizeError';
  }
}

/** 增量几何统计：三角形计数 + 毫米包围盒。 */
export interface GeometryStats {
  triangleCount: number;
  /** 毫米；无三角形时为 null。 */
  bboxMm: BoundingBox | null;
}
