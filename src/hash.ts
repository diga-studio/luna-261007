/**
 * Counter-based deterministic hashing: maps (instanceKey, nodeId) to a
 * standard normal sample. Pure functions of their inputs, no hidden state,
 * so any agent re-deriving the same node gets bit-identical results.
 */

const MASK64 = (1n << 64n) - 1n;
const GOLDEN = 0x9e3779b97f4a7c15n;

/** SplitMix64 finalizer: strong 64-bit avalanche mix. */
export function mix64(z: bigint): bigint {
  z = (z + GOLDEN) & MASK64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  return (z ^ (z >> 31n)) & MASK64;
}

/** FNV-1a 64-bit over UTF-16 code units, then avalanche. */
export function hashString(s: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * 0x100000001b3n) & MASK64;
  }
  return mix64(h);
}

/** Combine a 64-bit seed and a streamId into a per-instance key. */
export function instanceKey(seed: bigint, streamId: string): bigint {
  return mix64(mix64(seed & MASK64) ^ mix64(hashString(streamId) ^ 0x53545245414d6b65n));
}

/** 53-bit uniform in (0, 1] from a 64-bit hash (never exactly 0). */
function uniformOpen01(h: bigint): number {
  return (Number(h >> 11n) + 1) / 9007199254740992;
}

/** Deterministic standard normal sample for (key, nodeId) via Box-Muller. */
export function nodeGaussian(key: bigint, nodeId: bigint): number {
  const base = mix64(key ^ mix64(nodeId));
  const h1 = mix64(base);
  const h2 = mix64(base ^ 0x9e3779b97f4a7c15n);
  const u1 = uniformOpen01(h1);
  const u2 = Number(h2 >> 11n) / 9007199254740992;
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
