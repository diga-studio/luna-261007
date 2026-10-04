/** Internal work/space counters, exported so tests can verify complexity. */
export const internalStats = {
    /** Number of Gaussian node evaluations (PRNG draws) since last reset. */
    gaussDraws: 0,
    /** High-water mark of the readRange descent-stack depth since last reset. */
    maxStackDepth: 0,
    reset() {
        this.gaussDraws = 0;
        this.maxStackDepth = 0;
    },
};
