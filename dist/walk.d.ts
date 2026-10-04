/** Number of 1ms steps in 90 days; valid indices are 0..M inclusive. */
export declare const M = 7776000000;
/** A single random-walk trajectory. */
export interface Walk {
    /** Value at the given index; O(log M), no prior reads required. */
    valueAt(index: number): number;
    /**
     * Lazy iterator yielding `count` consecutive values starting at `start`
     * in increasing index order. Total work for k consumed points is
     * O(k + log M); stopping early performs no further work.
     */
    readRange(start: number, count: number): IterableIterator<number>;
}
/**
 * Create a walk instance. Construction performs a single PRNG draw (O(1)).
 * `seed` is a 64-bit integer (number or bigint); `sigma` must be positive.
 */
export declare function createWalk(seed: number | bigint, streamId: string, initial: number, sigma: number): Walk;
