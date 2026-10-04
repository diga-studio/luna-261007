import { internalStats } from './stats.js';

/** 64-bit integer mask. */
export const MASK64: bigint = (1n << 64n) - 1n;

const GOLDEN: bigint = 0x9e3779b97f4a7c15n;
const MIX_A: bigint = 0xbf58476d1ce4e5b9n;
const MIX_B: bigint = 0x94d049bb133111ebn;
const FNV_OFFSET: bigint = 0xcbf29ce484222325n;
const FNV_PRIME: bigint = 0x100000001b3n;

const TWO_POW_53 = 9007199254740992; // 2^53
const TWO_PI = 2 * Math.PI;

/** SplitMix64 finalizer: deterministic 64-bit bit-mixing. */
export function mix64(z: bigint): bigint {
  z = (z + GOLDEN) & MASK64;
  z = ((z ^ (z >> 30n)) * MIX_A) & MASK64;
  z = ((z ^ (z >> 27n)) * MIX_B) & MASK64;
  return (z ^ (z >> 31n)) & MASK64;
}

/** FNV-1a 64-bit hash of a string (over UTF-16 code units). */
export function hashString(s: string): bigint {
  let h = FNV_OFFSET;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * FNV_PRIME) & MASK64;
  }
  return h;
}

/** Uniform double in (0, 1) from a 64-bit state, using the top 53 bits. */
function uniformOpen01(state: bigint): number {
  // (v + 1) / (2^53 + 1) keeps the result strictly inside (0, 1).
  const v = Number(state >> 11n);
  return (v + 1) / (TWO_POW_53 + 1);
}

/**
 * Deterministic standard-normal variate for a keyed node.
 * Same (seed, streamHash, tag, a, b) always yields the identical double.
 * Box-Muller from two independent hash-derived uniforms.
 */
export function nodeGaussian(
  seed: bigint,
  streamHash: bigint,
  tag: bigint,
  a: number,
  b: number,
): number {
  internalStats.gaussDraws++;
  let h = mix64(seed ^ mix64(streamHash ^ mix64(tag)));
  h = mix64(h ^ BigInt(a));
  h = mix64(h ^ BigInt(b));
  const u1 = uniformOpen01(mix64(h));
  const u2 = uniformOpen01(mix64(h ^ GOLDEN));
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(TWO_PI * u2);
}
