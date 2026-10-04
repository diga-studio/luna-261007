/** Deterministic seeded RNG (mulberry32) so tests are reproducible. */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform integer in [0, 2^32). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let z = this.state;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return (z ^ (z >>> 14)) >>> 0;
  }

  /** Uniform integer in [lo, hi). */
  int(lo: number, hi: number): number {
    return lo + (this.next() % (hi - lo));
  }

  /** Pick a random element. */
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length)] as T;
  }
}
