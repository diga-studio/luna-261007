export const FEATURE_DIM = 16;
export const EMPTY_COVER_COST = 1040400;

/** deterministic PRNG (mulberry32) */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomFeatures(rng) {
  const f = new Array(FEATURE_DIM);
  for (let d = 0; d < FEATURE_DIM; d++) f[d] = Math.floor(rng() * 256);
  return f;
}

export function randomPool(rng, n, { idStart = 0, idShuffle = true } = {}) {
  const samples = [];
  for (let i = 0; i < n; i++) samples.push({ id: idStart + i, features: randomFeatures(rng) });
  if (idShuffle) {
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [samples[i], samples[j]] = [samples[j], samples[i]];
    }
  }
  return samples;
}

export function randomReps(rng, m, { weightMax = 10000 } = {}) {
  const reps = [];
  for (let j = 0; j < m; j++) {
    reps.push({ features: randomFeatures(rng), weight: 1 + Math.floor(rng() * weightMax) });
  }
  return reps;
}

function distSq(a, b) {
  let s = 0;
  for (let d = 0; d < FEATURE_DIM; d++) {
    const diff = a[d] - b[d];
    s += diff * diff;
  }
  return s;
}

/**
 * Reference implementation: literally follows the business definition.
 * samples: [{id, features}], reps: [{features, weight}], labeled: Set of ids.
 * Returns the greedy batch of size k (or fewer if pool exhausted).
 */
export function bruteForceRecommend(samples, reps, labeled, k) {
  const byId = new Map(samples.map((s) => [s.id, s]));
  const labeledList = [...labeled].map((id) => byId.get(id));
  const candidates = samples.filter((s) => !labeled.has(s.id));
  const selected = [];
  const steps = Math.min(k, candidates.length);
  for (let step = 0; step < steps; step++) {
    let best = null;
    let bestGain = -1;
    for (const cand of candidates) {
      if (selected.includes(cand)) continue;
      let gain = 0;
      for (const rep of reps) {
        let cur = EMPTY_COVER_COST;
        for (const s of labeledList) cur = Math.min(cur, distSq(s.features, rep.features));
        for (const s of selected) cur = Math.min(cur, distSq(s.features, rep.features));
        const after = Math.min(cur, distSq(cand.features, rep.features));
        gain += rep.weight * (cur - after);
      }
      if (gain > bestGain || (gain === bestGain && best !== null && cand.id < best.id)) {
        bestGain = gain;
        best = cand;
      }
    }
    selected.push(best);
  }
  return selected.map((s) => s.id);
}
