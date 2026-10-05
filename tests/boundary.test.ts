import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEARNING_WINDOW_MS,
  ProcessEvent,
  ingest,
  openWorkload,
  resetAll,
} from '../src/index';

const T0 = 1_000_000;
const END = T0 + LEARNING_WINDOW_MS;

function call(t: number, pid: number, n: number): ProcessEvent {
  return { t, pid, type: 'call', call: n };
}

test('process spanning the learning boundary keeps its call context', () => {
  resetAll();
  openWorkload('w-span', T0);
  // instance A (learning only): full sequence [1,2,3]
  // instance B: starts in learning, survives past the boundary
  const learning = ingest('w-span', [
    { t: T0 + 1, pid: 1, type: 'start' },
    call(T0 + 2, 1, 1),
    call(T0 + 3, 1, 2),
    call(T0 + 4, 1, 3),
    { t: T0 + 5, pid: 1, type: 'exit' },
    { t: T0 + 6, pid: 2, type: 'start' },
    call(T0 + 7, 2, 1),
    call(END - 1, 2, 2),
  ]);
  assert.deepStrictEqual(learning, []);
  // B's third call lands in the detection period; its full sequence [1,2,3]
  // matches A's learning sequence only if the pre-boundary context survived
  const out = ingest('w-span', [call(END + 1, 2, 3)]);
  assert.deepStrictEqual(out, [{ m: 3, k: 3, anomaly: false }]);
});

test('call exactly at the boundary belongs to the detection period', () => {
  resetAll();
  openWorkload('w-edge', T0);
  const learning = ingest('w-edge', [
    { t: T0 + 1, pid: 1, type: 'start' },
    call(T0 + 2, 1, 7),
    call(END - 1, 1, 7), // last learning call: no output
  ]);
  assert.deepStrictEqual(learning, []);
  // at t == t0 + 3600000 the call is already detection-period: it must be
  // scored (and must not extend the baseline)
  const out = ingest('w-edge', [call(END, 1, 7)]);
  assert.deepStrictEqual(out, [{ m: 2, k: 3, anomaly: true }]);
  // baseline is frozen: [7,7,7] was never a learning substring, so m stays 2
  const out2 = ingest('w-edge', [call(END + 1, 1, 7)]);
  assert.deepStrictEqual(out2, [{ m: 2, k: 4, anomaly: true }]);
});

test('repeated novel detection combinations never pollute the baseline', () => {
  resetAll();
  openWorkload('w-novel', T0);
  ingest('w-novel', [
    { t: T0 + 1, pid: 1, type: 'start' },
    call(T0 + 2, 1, 1),
    call(T0 + 3, 1, 2),
    { t: T0 + 4, pid: 1, type: 'exit' },
  ]);
  // first occurrence of the novel pair [9,9]: syscall 9 is unknown
  const first = ingest('w-novel', [
    { t: END + 1, pid: 2, type: 'start' },
    call(END + 2, 2, 9),
    call(END + 3, 2, 9),
  ]);
  assert.deepStrictEqual(first, [
    { m: 0, k: 1, anomaly: true },
    { m: 0, k: 2, anomaly: true },
  ]);
  // same novel combination again in a fresh instance: still fully anomalous,
  // proving detection samples never became normal samples
  const second = ingest('w-novel', [
    { t: END + 4, pid: 3, type: 'start' },
    call(END + 5, 3, 9),
    call(END + 6, 3, 9),
    call(END + 7, 3, 9),
  ]);
  assert.deepStrictEqual(second, [
    { m: 0, k: 1, anomaly: true },
    { m: 0, k: 2, anomaly: true },
    { m: 0, k: 3, anomaly: true },
  ]);
});

test('reused pid does not inherit the previous instance sequence', () => {
  resetAll();
  openWorkload('w-reuse', T0);
  ingest('w-reuse', [
    { t: T0 + 1, pid: 5, type: 'start' },
    call(T0 + 2, 5, 1),
    call(T0 + 3, 5, 2),
    call(T0 + 4, 5, 3),
    { t: T0 + 5, pid: 5, type: 'exit' },
  ]);
  // pid 5 reused after exit: the new instance starts from an empty sequence
  const out = ingest('w-reuse', [
    { t: END + 1, pid: 5, type: 'start' },
    call(END + 2, 5, 3),
  ]);
  assert.deepStrictEqual(out, [{ m: 1, k: 1, anomaly: false }]);
});

test('unknown syscall yields m = 0 and is always anomalous', () => {
  resetAll();
  openWorkload('w-zero', T0);
  ingest('w-zero', [
    { t: T0 + 1, pid: 1, type: 'start' },
    call(T0 + 2, 1, 1),
  ]);
  const out = ingest('w-zero', [call(END + 1, 1, 42)]);
  assert.deepStrictEqual(out, [{ m: 0, k: 2, anomaly: true }]);
});

test('workloads are isolated from each other', () => {
  resetAll();
  openWorkload('w-iso-a', T0);
  openWorkload('w-iso-b', T0);
  ingest('w-iso-a', [
    { t: T0 + 1, pid: 1, type: 'start' },
    call(T0 + 2, 1, 1),
    call(T0 + 3, 1, 2),
  ]);
  // [1,2] is normal in w-iso-a but unknown in w-iso-b
  const out = ingest('w-iso-b', [
    { t: END + 1, pid: 1, type: 'start' },
    call(END + 2, 1, 1),
    call(END + 3, 1, 2),
  ]);
  assert.deepStrictEqual(out, [
    { m: 0, k: 1, anomaly: true },
    { m: 0, k: 2, anomaly: true },
  ]);
});
