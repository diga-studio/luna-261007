/** Internal work/space counters, exported so tests can verify complexity. */
export declare const internalStats: {
    /** Number of Gaussian node evaluations (PRNG draws) since last reset. */
    gaussDraws: number;
    /** High-water mark of the readRange descent-stack depth since last reset. */
    maxStackDepth: number;
    reset(): void;
};
