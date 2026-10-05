/** 业务时钟，可由测试替换；时间不会回退。 */
export interface Clock {
  nowMs(): number;
}

export class SystemClock implements Clock {
  nowMs(): number {
    return Date.now();
  }
}

/** 测试用手动时钟。 */
export class ManualClock implements Clock {
  private current: number;
  constructor(startMs: number) {
    this.current = startMs;
  }
  nowMs(): number {
    return this.current;
  }
  setMs(ms: number): void {
    if (ms < this.current) throw new Error("clock cannot go backwards");
    this.current = ms;
  }
  advanceMs(delta: number): void {
    if (delta < 0) throw new Error("clock cannot go backwards");
    this.current += delta;
  }
}
