import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Detection,
  LEARNING_WINDOW_MS,
  ProcessEvent,
  ingest,
  openWorkload,
  resetAll,
} from '../src/index';
import { ReferenceBaseline } from './reference';

/** deterministic LCG so failures are reproducible */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

interface GenState {
  active: Set<number>;
  exited: number[];
  nextPid: number;
}

function genEvents(
  rng: () => number,
  t0: number,
  count: number,
): ProcessEvent[] {
  const st: GenState = { active: new Set(), exited: [], nextPid: 1 };
  const events: ProcessEvent[] = [];
  let t = t0;
  const span = LEARNING_WINDOW_MS + 600_000;
  const step = span / count;
  for (let i = 0; i < count; i++) {
    t += Math.floor(rng() * step * 2);
    const r = rng();
    if (st.active.size === 0 || r < 0.25) {
      // start: fresh pid, or reuse a previously exited pid
      let pid: number;
      if (st.exited.length > 0 && rng() < 0.5) {
        pid = st.exited.splice(Math.floor(rng() * st.exited.length), 1)[0]!;
      } else {
        pid = st.nextPid++;
      }
      st.active.add(pid);
      events.push({ t, pid, type: 'start' });
    } else if (r < 0.9 || st.active.size <= 1) {
      // call on a random live process; bias low syscall numbers so that
      // learning sequences share plenty of substrings
      const pids = [...st.active];
      const pid = pids[Math.floor(rng() * pids.length)]!;
      const call = Math.floor(rng() * rng() * 12);
      events.push({ t, pid, type: 'call', call });
    } else {
      const pids = [...st.active];
      const pid = pids[Math.floor(rng() * pids.length)]!;
      st.active.delete(pid);
      st.exited.push(pid);
      events.push({ t, pid, type: 'exit' });
    }
  }
  events.sort((a, b) => a.t - b.t);
  return events;
}

test('randomized cross-check against enumerating reference', () => {
  resetAll();
  const ref = new ReferenceBaseline();
  const rng = makeRng(20261005);
  const workloadIds = ['w-alpha', 'w-beta', 'w-gamma'];
  const streams = new Map<string, ProcessEvent[]>();
  for (const id of workloadIds) {
    const t0 = 1_700_000_000_000 + Math.floor(rng() * 10_000);
    openWorkload(id, t0);
    ref.openWorkload(id, t0);
    streams.set(id, genEvents(rng, t0, 400));
  }
  // interleave ingestion across workloads in random batches; each workload
  // keeps its own non-decreasing time order
  const cursors = new Map(workloadIds.map((id) => [id, 0]));
  let remaining = workloadIds.length;
  let checked = 0;
  while (remaining > 0) {
    const id = workloadIds[Math.floor(rng() * workloadIds.length)]!;
    const stream = streams.get(id)!;
    const at = cursors.get(id)!;
    if (at >= stream.length) {
      continue;
    }
    const batch = stream.slice(at, at + 1 + Math.floor(rng() * 17));
    cursors.set(id, at + batch.length);
    if (cursors.get(id)! >= stream.length) {
      remaining--;
    }
    const got = ingest(id, batch);
    const want = ref.ingest(id, batch);
    // learning-period batches produce no output at all
    for (const d of got) {
      checked++;
    }
    assert.deepStrictEqual(got, want, `mismatch in workload ${id}`);
  }
  assert.ok(checked > 0, 'expected some detection-period calls');
});

test('pseudo-normal combination spanning two independent sequences', () => {
  resetAll();
  const t0 = 1_000_000;
  openWorkload('w-join', t0);
  // two independent learning instances: [1,2,3,4] and [5,6,7,8]
  ingest('w-join', [
    { t: t0 + 1, pid: 1, type: 'start' },
    { t: t0 + 2, pid: 1, type: 'call', call: 1 },
    { t: t0 + 3, pid: 1, type: 'call', call: 2 },
    { t: t0 + 4, pid: 1, type: 'call', call: 3 },
    { t: t0 + 5, pid: 1, type: 'call', call: 4 },
    { t: t0 + 6, pid: 1, type: 'exit' },
    { t: t0 + 7, pid: 2, type: 'start' },
    { t: t0 + 8, pid: 2, type: 'call', call: 5 },
    { t: t0 + 9, pid: 2, type: 'call', call: 6 },
    { t: t0 + 10, pid: 2, type: 'call', call: 7 },
    { t: t0 + 11, pid: 2, type: 'call', call: 8 },
    { t: t0 + 12, pid: 2, type: 'exit' },
  ]);
  // detection: 1..8 only looks normal if the two sequences were (wrongly)
  // concatenated into one; correct m is 4 (suffix 5,6,7,8), not 8
  const t1 = t0 + LEARNING_WINDOW_MS + 1;
  const out = ingest('w-join', [
    { t: t1, pid: 9, type: 'start' },
    ...[1, 2, 3, 4, 5, 6, 7, 8].map(
      (call, i): ProcessEvent => ({ t: t1 + 1 + i, pid: 9, type: 'call', call }),
    ),
  ]);
  const last: Detection = out[out.length - 1]!;
  assert.equal(last.k, 8);
  assert.equal(last.m, 4);
  assert.equal(last.anomaly, true);
});
