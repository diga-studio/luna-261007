import { test } from 'node:test';
import { equal, ok } from 'node:assert/strict';
import { cluster, Record } from '../src';
import {
  bruteForceClusters,
  clusteredPartitions,
  mulberry32,
  normalize,
  randomLetter,
  randomValue,
  shuffle,
} from './helpers';

test('chain: A~B and B~C cluster together even when A!~C', () => {
  // d(A,B) = d(B,C) = 1 (similar), d(A,C) = 2 (not similar, 20 > 10).
  const a = 'abcdefghij';
  const b = 'abxdefghij';
  const c = 'abxyefghij';
  const records: Record[] = [
    { id: 'A', value: a },
    { id: 'B', value: b },
    { id: 'C', value: c },
  ];
  const { clusters } = cluster(records);
  equal(normalize(clusters), normalize([['A', 'B', 'C']]));
});

test('chain with duplicate values is stable under shuffling', () => {
  const base: Record[] = [
    { id: 'A', value: 'abcdefghij' },
    { id: 'B', value: 'abxdefghij' },
    { id: 'C', value: 'abxyefghij' },
    { id: 'A2', value: 'abcdefghij' }, // same value as A, different id
    { id: 'C2', value: 'abxyefghij' }, // same value as C, different id
    { id: 'alone', value: 'zzzzzzzzzzzz' },
  ];
  const expected = normalize([['A', 'A2', 'B', 'C', 'C2']]);
  const rnd = mulberry32(777);
  for (let trial = 0; trial < 25; trial++) {
    const shuffled = shuffle(base.slice(), rnd);
    equal(clusteredPartitions(shuffled), expected, `trial ${trial}`);
  }
});

test('input permutation never changes the partition', () => {
  const rnd = mulberry32(4242);
  const records: Record[] = [];
  for (let i = 0; i < 60; i++) {
    records.push({ id: `id${i}`, value: randomValue(rnd, 8, 32) });
  }
  // Plant near-neighbors and duplicates.
  for (let i = 0; i < 20; i++) {
    const source = records[Math.floor(rnd() * records.length)].value;
    const chars = source.split('');
    chars[Math.floor(rnd() * chars.length)] = randomLetter(rnd);
    records.push({ id: `near${i}`, value: chars.join('') });
    records.push({ id: `dup${i}`, value: source });
  }
  const expected = clusteredPartitions(records);
  for (let trial = 0; trial < 25; trial++) {
    equal(clusteredPartitions(shuffle(records.slice(), rnd)), expected);
  }
});

test('random inputs match brute-force reference (fixed seeds)', () => {
  for (const seed of [1, 7, 42, 1337, 20261006]) {
    const rnd = mulberry32(seed);
    for (let trial = 0; trial < 40; trial++) {
      const records: Record[] = [];
      const n = 2 + Math.floor(rnd() * 40);
      for (let i = 0; i < n; i++) {
        const roll = rnd();
        let value: string;
        if (roll < 0.2 && records.length > 0) {
          // Exact duplicate value under a new id.
          value = records[Math.floor(rnd() * records.length)].value;
        } else if (roll < 0.3) {
          // Repetitive letter string.
          const letter = randomLetter(rnd);
          value = letter.repeat(8 + Math.floor(rnd() * 25));
        } else if (roll < 0.75 && records.length > 0) {
          // Near neighbor via 1-3 inserts / deletes / substitutes.
          const chars = records[Math.floor(rnd() * records.length)].value.split('');
          const edits = 1 + Math.floor(rnd() * 3);
          for (let e = 0; e < edits; e++) {
            const op = rnd();
            if (op < 0.4 && chars.length < 32) {
              chars.splice(Math.floor(rnd() * (chars.length + 1)), 0, randomLetter(rnd));
            } else if (op < 0.7 && chars.length > 8) {
              chars.splice(Math.floor(rnd() * chars.length), 1);
            } else {
              chars[Math.floor(rnd() * chars.length)] = randomLetter(rnd);
            }
          }
          value = chars.join('');
        } else {
          value = randomValue(rnd, 8, 32);
        }
        records.push({ id: `s${seed}t${trial}i${i}`, value });
      }
      const got = clusteredPartitions(records);
      const expected = normalize(bruteForceClusters(records));
      equal(got, expected, `seed ${seed} trial ${trial}`);
    }
  }
});

test('lengths exactly on both sides of the threshold', () => {
  // d = 1 with maxLen 10 -> similar; d = 1 with maxLen 9 -> not similar.
  const similar = cluster([
    { id: 1, value: 'abcdefghij' },
    { id: 2, value: 'xbcdefghij' }, // first letter differs, still similar
  ]);
  equal(normalize(similar.clusters), normalize([[1, 2]]));

  const notSimilar = cluster([
    { id: 1, value: 'abcdefghi' },
    { id: 2, value: 'xbcdefghi' }, // d = 1, maxLen = 9, 10 > 9
  ]);
  equal(notSimilar.clusters.length, 0);

  // d = 2 with maxLen 20 -> similar; d = 2 with maxLen 19 -> not similar.
  const similar20 = cluster([
    { id: 1, value: 'abcdefghijklmnopqrst' },
    { id: 2, value: 'abcdefghijklmnopqr' },
  ]);
  equal(normalize(similar20.clusters), normalize([[1, 2]]));

  const notSimilar19 = cluster([
    { id: 1, value: 'abcdefghijklmnopqrs' },
    { id: 2, value: 'abcdefghijklmnopq' },
  ]);
  equal(notSimilar19.clusters.length, 0);
});

test('first letters differ but records are still similar', () => {
  const { clusters } = cluster([
    { id: 'x', value: 'zaaaaaaaaaaaaaaa' },
    { id: 'y', value: 'aaaaaaaaaaaaaaaa' },
  ]);
  equal(normalize(clusters), normalize([['x', 'y']]));
});

test('singletons and empty input produce no clusters', () => {
  equal(cluster([]).clusters.length, 0);
  const { clusters, stats } = cluster([
    { id: 1, value: 'aaaaaaaa' },
    { id: 2, value: 'bbbbbbbb' },
  ]);
  equal(clusters.length, 0);
  ok(stats.distanceChecks >= 0);
});
