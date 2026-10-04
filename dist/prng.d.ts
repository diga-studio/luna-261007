/** 64-bit integer mask. */
export declare const MASK64: bigint;
/** SplitMix64 finalizer: deterministic 64-bit bit-mixing. */
export declare function mix64(z: bigint): bigint;
/** FNV-1a 64-bit hash of a string (over UTF-16 code units). */
export declare function hashString(s: string): bigint;
/**
 * Deterministic standard-normal variate for a keyed node.
 * Same (seed, streamHash, tag, a, b) always yields the identical double.
 * Box-Muller from two independent hash-derived uniforms.
 */
export declare function nodeGaussian(seed: bigint, streamHash: bigint, tag: bigint, a: number, b: number): number;
