import type { Clock } from '../src/index.js';

/** Manually advanced monotonic millisecond clock. */
export class ManualClock implements Clock {
  private t: number;

  constructor(start = 1_700_000_000_000) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  advance(ms: number): void {
    if (ms < 0) throw new Error('clock may only move forward');
    this.t += ms;
  }

  set(t: number): void {
    if (t < this.t) throw new Error('clock may only move forward');
    this.t = t;
  }
}

/**
 * beforeCommit hook whose invocations can be paused and released by the test.
 * `pause()` holds every invocation; `pauseNext(n)` holds only the next n
 * invocations and lets later ones through (FIFO holds are released together).
 */
export class HookGate {
  calls = 0;
  private holdAll = false;
  private holdNext = 0;
  private waiters: Array<() => void> = [];

  readonly hook = async (): Promise<void> => {
    this.calls += 1;
    const held = this.holdAll || this.holdNext > 0;
    if (this.holdNext > 0) this.holdNext -= 1;
    if (held) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  };

  pause(): void {
    this.holdAll = true;
  }

  pauseNext(n = 1): void {
    this.holdNext += n;
  }

  release(): void {
    this.holdAll = false;
    const pending = this.waiters.splice(0);
    for (const resolve of pending) resolve();
  }
}

export const BASE_RATES = {
  BTC: '20000.00000000',
  ETH: '3000.00000000',
  USDT: '1.00000000',
  SOL: '150.00000000',
  XRP: '0.50000000',
} as const;

export const DAY_MS = 24 * 60 * 60 * 1000;
