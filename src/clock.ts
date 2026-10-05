import type { Clock } from './types.js';

/** Manually advanceable logical clock, primarily for tests. */
export class ManualClock implements Clock {
  private current: number;

  constructor(start = 0) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    if (ms < 0) throw new Error('cannot advance clock by a negative amount');
    this.current += ms;
  }

  set(ms: number): void {
    this.current = ms;
  }
}
