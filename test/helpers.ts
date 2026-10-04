import { FEATURE_DIM, FEATURE_MAX, MAX_DISTANCE } from "../src/index.ts";
import type { RepresentativeInput, SampleInput } from "../src/index.ts";

/** 两个特征之间的距离：各维差值平方之和。 */
export function distance(a: readonly number[], b: readonly number[]): number {
  let sum = 0;
  for (let d = 0; d < FEATURE_DIM; d++) {
    const diff = a[d]! - b[d]!;
    sum += diff * diff;
  }
  return sum;
}

/**
 * 总覆盖代价：各代表点到给定样本集合的最小距离乘以权重后求和。
 * 集合为空时每个代表点的代价取 MAX_DISTANCE。用 BigInt 精确求和。
 */
export function totalCoverageCost(
  representatives: readonly RepresentativeInput[],
  coveredBy: readonly SampleInput[],
): bigint {
  let total = 0n;
  for (const rep of representatives) {
    let best = MAX_DISTANCE;
    for (const sample of coveredBy) {
      const d = distance(rep.features, sample.features);
      if (d < best) best = d;
    }
    total += BigInt(rep.weight) * BigInt(best);
  }
  return total;
}

/**
 * 直接按业务定义计算的参考实现（暴力、逐步重算、精确）。
 * 用于在小规模数据上对照库的实现。
 */
export function bruteForceRecommend(
  samples: readonly SampleInput[],
  representatives: readonly RepresentativeInput[],
  labeledIds: ReadonlySet<number>,
  count: number,
): number[] {
  const labeled = samples.filter((s) => labeledIds.has(s.id));
  const curMin = representatives.map((rep) => {
    let best = MAX_DISTANCE;
    for (const s of labeled) {
      const d = distance(rep.features, s.features);
      if (d < best) best = d;
    }
    return best;
  });

  const remaining = samples.filter((s) => !labeledIds.has(s.id));
  const chosen: SampleInput[] = [];
  const result: number[] = [];
  const steps = Math.min(count, remaining.length);
  for (let step = 0; step < steps; step++) {
    let bestGain = -1n;
    let bestId = -1;
    let bestIndex = -1;
    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i]!;
      let gain = 0n;
      for (let r = 0; r < representatives.length; r++) {
        const delta = curMin[r]! - distance(representatives[r]!.features, candidate.features);
        if (delta > 0) gain += BigInt(representatives[r]!.weight) * BigInt(delta);
      }
      if (gain > bestGain || (gain === bestGain && candidate.id < bestId)) {
        bestGain = gain;
        bestId = candidate.id;
        bestIndex = i;
      }
    }
    const picked = remaining.splice(bestIndex, 1)[0]!;
    chosen.push(picked);
    result.push(picked.id);
    for (let r = 0; r < representatives.length; r++) {
      const d = distance(representatives[r]!.features, picked.features);
      if (d < curMin[r]!) curMin[r] = d;
    }
  }
  return result;
}

/** 确定性伪随机数发生器（mulberry32）。 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 生成一条随机特征向量。 */
export function randomFeatures(rand: () => number): number[] {
  const features = new Array<number>(FEATURE_DIM);
  for (let d = 0; d < FEATURE_DIM; d++) {
    features[d] = Math.floor(rand() * (FEATURE_MAX + 1));
  }
  return features;
}

/** 生成 n 条样本，ID 为 0..n-1 的随机排列（不同 ID 可有相同特征由调用方构造）。 */
export function randomSamples(n: number, rand: () => number): SampleInput[] {
  const ids = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = ids[i]!;
    ids[i] = ids[j]!;
    ids[j] = tmp;
  }
  return ids.map((id) => ({ id, features: randomFeatures(rand) }));
}

/** 生成 m 个代表点，权重为 1..10000 的随机整数。 */
export function randomRepresentatives(m: number, rand: () => number): RepresentativeInput[] {
  const reps: RepresentativeInput[] = [];
  for (let r = 0; r < m; r++) {
    reps.push({ features: randomFeatures(rand), weight: 1 + Math.floor(rand() * 10_000) });
  }
  return reps;
}
