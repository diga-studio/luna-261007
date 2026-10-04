import type { Clock, Rates } from '../src/types';

export class FakeClock implements Clock {
  private current: number;

  constructor(start = 1_700_000_000_000) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    if (ms < 0) throw new Error('clock cannot move backwards');
    this.current += ms;
  }
}

/** A beforeCommit hook that pauses until released manually. */
export class GateHook {
  calls = 0;
  private waiters: Array<() => void> = [];

  readonly hook = (): Promise<void> => {
    this.calls += 1;
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  };

  get paused(): boolean {
    return this.waiters.length > 0;
  }

  release(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
  }
}

export const BASE_RATES: Rates = {
  BTC: '20000.00000000',
  ETH: '3000.00000000',
  USDT: '1.00000000',
  SOL: '100.00000000',
  XRP: '0.50000000',
};

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

/** Let pending microtasks (e.g. transfer reaching the hook) run. */
export async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
