/** 可注入的时钟，便于测试用假时钟控制时间 */
export interface Clock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** 默认系统时钟 */
export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    return setTimeout(callback, delayMs);
  }

  clearTimeout(handle: unknown): void {
    clearTimeout(handle as NodeJS.Timeout);
  }
}
