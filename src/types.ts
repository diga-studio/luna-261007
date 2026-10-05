/** 可信硬件配置：地址窗口均为半开区间 [base, base + size)。 */
export interface HardwareTarget {
  /** 物理 flash 容量（字节），每个别名窗口长度均为此值。 */
  flashSize: number;
  /** flash 别名窗口的基地址列表，每个窗口映射到同一份物理 flash。 */
  flashAliases: number[];
  /** RAM 窗口基地址。 */
  ramBase: number;
  /** RAM 窗口长度（字节）。 */
  ramSize: number;
  /** flash 占用预算（字节），不超过 flashSize。 */
  flashBudget: number;
  /** RAM 占用预算（字节），不超过 ramSize。 */
  ramBudget: number;
}

/** 可供 readFlash 使用的已校验固件映像（不透明句柄）。 */
export interface FlashImage {
  readonly flashUsed: number;
  readonly ramUsed: number;
}

export interface AnalyzeSuccess {
  readonly ok: true;
  readonly flashUsed: number;
  readonly ramUsed: number;
  readonly image: FlashImage;
}

export interface AnalyzeFailure {
  readonly ok: false;
  readonly error: string;
}

export type AnalyzeResult = AnalyzeSuccess | AnalyzeFailure;
