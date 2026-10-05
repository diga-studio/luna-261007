import test from 'node:test';
import assert from 'node:assert/strict';
import { selectGrantsToKeep } from '../src/optimizer.js';

function cov(...keys: string[]): Set<string> {
  return new Set(keys);
}

test('empty evidence allows revoking all grants', () => {
  const keep = selectGrantsToKeep([1, 2], [cov('a'), cov('b')], new Set());
  assert.deepEqual(keep, []);
});

test('fewer grants but larger exposure loses to smaller union', () => {
  // Grant 1 alone covers the evidence but exposes 2 unobserved keys.
  // Grants 2+3 together cover the evidence with zero extra exposure.
  const ids = [1, 2, 3];
  const coverages = [cov('e', 'x1', 'x2'), cov('e'), cov('e')];
  const keep = selectGrantsToKeep(ids, coverages, new Set(['e']));
  assert.deepEqual(keep, [2]);
});

test('every grant individually used, yet a combination is revocable', () => {
  // e1 only in grant 1, e3 only in grant 3 -> 1 and 3 must stay.
  // e2 is in both grant 1 and grant 2; grant 2 becomes redundant.
  const ids = [1, 2, 3];
  const coverages = [cov('e1', 'e2'), cov('e2'), cov('e3')];
  const keep = selectGrantsToKeep(ids, coverages, new Set(['e1', 'e2', 'e3']));
  assert.deepEqual(keep, [1, 3]);
});

test('does not keep a grant merely because it matched an access', () => {
  // Grant 2 matches evidence e2, but grant 1 covers everything needed.
  const ids = [1, 2];
  const coverages = [cov('e1', 'e2'), cov('e2')];
  const keep = selectGrantsToKeep(ids, coverages, new Set(['e1', 'e2']));
  assert.deepEqual(keep, [1]);
});

test('tie on union size and count breaks by lexicographic id order', () => {
  const ids = [5, 3, 9];
  const coverages = [cov('e'), cov('e'), cov('e')];
  const keep = selectGrantsToKeep(ids, coverages, new Set(['e']));
  assert.deepEqual(keep, [3]);
});

test('result is independent of input order', () => {
  const coverages = [cov('e1', 'e2'), cov('e2'), cov('e3')];
  const forward = selectGrantsToKeep([1, 2, 3], coverages, new Set(['e1', 'e2', 'e3']));
  const backward = selectGrantsToKeep([3, 2, 1], [...coverages].reverse(), new Set(['e3', 'e1', 'e2']));
  assert.deepEqual(forward, backward);
});

test('infeasible evidence throws', () => {
  assert.throws(() => selectGrantsToKeep([1], [cov('a')], new Set(['missing'])));
});
