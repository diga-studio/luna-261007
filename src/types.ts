/** Trusted hardware configuration describing flash aliases, RAM window and budgets. */
export interface HardwareTarget {
  /** Size in bytes of the physical flash (each alias window has this length). */
  flashSize: number;
  /** Base addresses of flash alias windows; every window maps to the same physical flash. */
  flashAliases: number[];
  /** Base address of the single RAM window. */
  ramBase: number;
  /** Size in bytes of the RAM window. */
  ramSize: number;
  /** Maximum allowed physical flash bytes covered by payloads. */
  flashBudget: number;
  /** Maximum allowed RAM bytes covered by runtime regions. */
  ramBudget: number;
}

/** Result of a successful firmware analysis. */
export interface FirmwareResult {
  /** Bytes of physical flash covered by payloads after alias normalization. */
  readonly flashUsed: number;
  /** Length of the union of RAM runtime ranges. */
  readonly ramUsed: number;
}

/** Error thrown when a firmware image or target configuration is rejected. */
export class FirmwareError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FirmwareError";
  }
}
