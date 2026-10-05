import test from 'node:test';
import assert from 'node:assert/strict';
import { collectEvidenceKeys, tripleKey, WINDOW_MS } from '../src/evidence.js';
import type { AccessEvent, Triple } from '../src/types.js';

const NOW = 1_000_000_000_000;
const triple: Triple = { environment: 'prod', resourceType: 'bucket', action: 'read' };

function event(offsetMs: number, success = true, t: Triple = triple): AccessEvent {
  return { triple: t, timestamp: NOW + offsetMs, success };
}

test('includes access exactly at window start (T-720h)', () => {
  const keys = collectEvidenceKeys([event(-WINDOW_MS)], NOW);
  assert.deepEqual([...keys], [tripleKey(triple)]);
});

test('excludes access exactly at T and before window start', () => {
  const keys = collectEvidenceKeys([event(0), event(-WINDOW_MS - 1)], NOW);
  assert.equal(keys.size, 0);
});

test('ignores failed accesses inside the window', () => {
  const keys = collectEvidenceKeys([event(-1000, false)], NOW);
  assert.equal(keys.size, 0);
});

test('deduplicates repeated accesses to the same triple', () => {
  const keys = collectEvidenceKeys([event(-100), event(-200), event(-300)], NOW);
  assert.equal(keys.size, 1);
});

test('collects distinct triples', () => {
  const other: Triple = { environment: 'dev', resourceType: 'queue', action: 'write' };
  const keys = collectEvidenceKeys([event(-100), event(-100, true, other)], NOW);
  assert.equal(keys.size, 2);
});
