import { test } from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { cluster, Id, Record } from '../src';
import { mulberry32, randomLetter, shuffle } from './helpers';

const SOURCE_COUNT = 60000;
const VARIANT_COUNT = 20000;
const IDENTICAL_COUNT = 20000;
const VALUE_LEN = 24;
const IDENTICAL_VALUE = 'a'.repeat(VALUE_LEN);
const MAX_DISTANCE_CHECKS = 2_000_000;

test('100k records: exact clusters within distance-check budget', () => {
  const rnd = mulberry32(20261006);
  const used = new Set<string>();

  // 60000 distinct pseudo-random source values of length 24.
  const sources: string[] = [];
  while (sources.length < SOURCE_COUNT) {
    let value = '';
    for (let i = 0; i < VALUE_LEN; i++) value += randomLetter(rnd);
    if (used.has(value)) continue;
    used.add(value);
    sources.push(value);
  }

  // 20000 single-substitution variants, each from a distinct source.
  const sourceOrder = shuffle(sources.map((_, i) => i), rnd);
  const variants: { source: number; value: string }[] = [];
  for (let i = 0; i < VARIANT_COUNT; i++) {
    const source = sourceOrder[i];
    let variant = '';
    do {
      const chars = sources[source].split('');
      const pos = Math.floor(rnd() * VALUE_LEN);
      let letter = randomLetter(rnd);
      while (letter === chars[pos]) letter = randomLetter(rnd);
      chars[pos] = letter;
      variant = chars.join('');
    } while (used.has(variant));
    used.add(variant);
    variants.push({ source, value: variant });
  }

  // Assemble and shuffle 100000 records.
  const records: Record[] = [];
  sources.forEach((value, i) => records.push({ id: `src${i}`, value }));
  variants.forEach((variant, i) => records.push({ id: `var${i}`, value: variant.value }));
  for (let i = 0; i < IDENTICAL_COUNT; i++) {
    records.push({ id: `dup${i}`, value: IDENTICAL_VALUE });
  }
  equal(records.length, 100000);
  shuffle(records, rnd);

  const { clusters, stats } = cluster(records);

  // Budget: candidate retrieval distance computations included.
  ok(
    stats.distanceChecks <= MAX_DISTANCE_CHECKS,
    `distanceChecks ${stats.distanceChecks} exceeds ${MAX_DISTANCE_CHECKS}`
  );

  // Map every id to its cluster.
  const clusterOf = new Map<Id, number>();
  clusters.forEach((ids, index) => {
    for (const id of ids) clusterOf.set(id, index);
  });

  // The identical-value cluster contains exactly all 20000 dup ids.
  const dupClusterIndex = clusterOf.get('dup0');
  if (dupClusterIndex === undefined) throw new Error('dup ids must be clustered');
  const dupCluster = clusters[dupClusterIndex];
  equal(dupCluster.length, IDENTICAL_COUNT);
  for (let i = 0; i < IDENTICAL_COUNT; i++) {
    equal(clusterOf.get(`dup${i}`), dupClusterIndex);
  }

  // Every variant shares a cluster with its source (full result, no sampling).
  for (let i = 0; i < VARIANT_COUNT; i++) {
    const variantCluster = clusterOf.get(`var${i}`);
    ok(variantCluster !== undefined, `var${i} must be clustered`);
    equal(
      clusterOf.get(`src${variants[i].source}`),
      variantCluster,
      `var${i} must share a cluster with its source`
    );
  }

  // Exactly one cluster per variant-source pair plus the identical cluster.
  equal(clusters.length, VARIANT_COUNT + 1);
});
