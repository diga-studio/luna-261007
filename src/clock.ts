export class LogicalClock {
  private current: number;

  constructor(startMs = 0) {
    this.current = startMs;
  }

  now(): number {
    return this.current;
  }

  advance(ms: number): number {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new Error(`cannot advance clock by ${ms}`);
    }
    this.current += ms;
    return this.current;
  }
}
