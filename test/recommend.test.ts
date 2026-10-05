import test from 'node:test';
import assert from 'node:assert/strict';
import { recommend } from '../src/index.js';
import type { AccessEvent, Grant, Snapshot, Triple } from '../src/types.js';

const NOW = 1_000_000_000_000;
const HOUR = 60 * 60 * 1000;

function triple(env: string, res: string, act: string): Triple {
  return { environment: env, resourceType: res, action: act };
}

function grant(id: number, ...triples: Triple[]): Grant {
  return { id, coverage: triples };
}

function access(t: Triple, hoursAgo: number, success = true): AccessEvent {
  return { triple: t, timestamp: NOW - hoursAgo * HOUR, success };
}

function snapshot(grants: Grant[], accesses: AccessEvent[]): Snapshot {
  return { now: NOW, grants, accesses };
}

/** Independent exhaustive search used as the oracle. */
function bruteForce(snap: Snapshot): { keep: number[]; revoke: number[] } {
  const start = snap.now - 720 * HOUR;
  const evidence = new Set<string>();
  for (const a of snap.accesses) {
    if (a.success && a.timestamp >= start && a.timestamp < snap.now) {
      evidence.add(JSON.stringify([a.triple.environment, a.triple.resourceType, a.triple.action]));
    }
  }
  const covs = snap.grants.map((g) =>
    new Set(g.coverage.map((t) => JSON.stringify([t.environment, t.resourceType, t.action]))),
  );
  const n = snap.grants.length;
  let best: { union: number; count: number; ids: number[] } | null = null;
  for (let mask = 0; mask < 1 << n; mask++) {
    const union = new Set<string>();
    const ids: number[] = [];
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) {
        ids.push(snap.grants[i]!.id);
        for (const k of covs[i]!) union.add(k);
      }
    }
    let feasible = true;
    for (const e of evidence) {
      if (!union.has(e)) {
        feasible = false;
        break;
      }
    }
    if (!feasible) continue;
    ids.sort((a, b) => a - b);
    const cand = { union: union.size, count: ids.length, ids };
    if (
      best === null ||
      cand.union < best.union ||
      (cand.union === best.union && cand.count < best.count) ||
      (cand.union === best.union &&
        cand.count === best.count &&
        cand.ids.join(',') < best.ids.join(','))
    ) {
      best = cand;
    }
  }
  assert.ok(best, 'oracle must find a feasible solution');
  const keepSet = new Set((best as { ids: number[] }).ids);
  return {
    keep: (best as { ids: number[] }).ids,
    revoke: snap.grants.map((g) => g.id).filter((id) => !keepSet.has(id)).sort((a, b) => a - b),
  };
}

test('scenario: minimal grant count is not minimal exposure', () => {
  // Grant 1 covers the evidence alone but allows 3 unobserved triples.
  // Grants 2+3 cover the evidence jointly with zero extra exposure.
  const e1 = triple('prod', 'db', 'read');
  const e2 = triple('prod', 'db', 'write');
  const grants = [
    grant(1, e1, e2, triple('prod', 'db', 'delete'), triple('prod', 'bucket', 'read'), triple('dev', 'db', 'read')),
    grant(2, e1),
    grant(3, e2),
  ];
  const accesses = [access(e1, 10), access(e2, 20)];
  const snap = snapshot(grants, accesses);
  const result = recommend(snap);
  assert.deepEqual(result, { keep: [2, 3], revoke: [1] });
  assert.deepEqual(result, bruteForce(snap));
});

test('scenario: every grant has individual evidence, combination still revocable', () => {
  const e1 = triple('prod', 'vm', 'start');
  const e2 = triple('prod', 'vm', 'stop');
  const e3 = triple('prod', 'vm', 'restart');
  // Grant 2 saw real use (e2), but grant 1 already covers e2.
  const grants = [grant(11, e1, e2), grant(22, e2), grant(33, e3)];
  const accesses = [access(e1, 5), access(e2, 6), access(e3, 7)];
  const snap = snapshot(grants, accesses);
  const result = recommend(snap);
  assert.deepEqual(result, { keep: [11, 33], revoke: [22] });
  assert.deepEqual(result, bruteForce(snap));
});

test('no evidence revokes everything', () => {
  const grants = [grant(1, triple('a', 'b', 'c')), grant(2, triple('d', 'e', 'f'))];
  const result = recommend(snapshot(grants, []));
  assert.deepEqual(result, { keep: [], revoke: [1, 2] });
});

test('result is invariant to grant order, log order, and duplicate logs', () => {
  const e1 = triple('prod', 'db', 'read');
  const e2 = triple('prod', 'db', 'write');
  const grants = [grant(1, e1, e2), grant(2, e1), grant(3, e2)];
  const accesses = [access(e1, 1), access(e2, 2)];
  const base = recommend(snapshot(grants, accesses));

  const shuffledGrants = [grants[2]!, grants[0]!, grants[1]!];
  const duplicatedLogs = [accesses[1]!, accesses[0]!, accesses[1]!, accesses[0]!, accesses[0]!];
  const permuted = recommend(snapshot(shuffledGrants, duplicatedLogs));

  assert.deepEqual(permuted, base);
  assert.deepEqual(base, bruteForce(snapshot(grants, accesses)));
});

test('out-of-window and failed accesses are not evidence', () => {
  const e1 = triple('prod', 'db', 'read');
  const grants = [grant(1, e1)];
  const accesses = [access(e1, 720.001), access(e1, 1, false), access(e1, -1)];
  const result = recommend(snapshot(grants, accesses));
  assert.deepEqual(result, { keep: [], revoke: [1] });
});

test('duplicate grant ids are rejected', () => {
  const e1 = triple('prod', 'db', 'read');
  assert.throws(() => recommend(snapshot([grant(1, e1), grant(1, e1)], [])));
});

test('matches brute-force oracle on randomized instances', () => {
  // Deterministic PRNG (mulberry32).
  let state = 42;
  const rand = (): number => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;

  const pool: Triple[] = [];
  for (const env of ['prod', 'dev']) {
    for (const res of ['db', 'bucket', 'vm']) {
      for (const act of ['read', 'write']) {
        pool.push(triple(env, res, act));
      }
    }
  }

  for (let round = 0; round < 200; round++) {
    const grantCount = 1 + Math.floor(rand() * 6);
    const grants: Grant[] = [];
    for (let i = 0; i < grantCount; i++) {
      const size = 1 + Math.floor(rand() * 4);
      const coverage: Triple[] = [];
      for (let j = 0; j < size; j++) coverage.push(pick(pool));
      grants.push(grant(100 + i, ...coverage));
    }
    const accesses: AccessEvent[] = [];
    const accessCount = Math.floor(rand() * 8);
    for (let i = 0; i < accessCount; i++) {
      const g = pick(grants);
      const t = pick(g.coverage);
      accesses.push(access(t, Math.floor(rand() * 700), rand() > 0.1));
    }
    const snap = snapshot(grants, accesses);
    assert.deepEqual(recommend(snap), bruteForce(snap), `round ${round}`);
  }
});
