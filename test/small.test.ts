import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { build, duration, plan } from '../src/index';
import type { EdlNode, Fps, Recording } from '../src/index';
import { expandEdl, refDuration, refFrameCount, refSample } from './refimpl';
import { checkPlanPages } from './check';

// Recordings: valid segments only; pauses between them never enter timelines.
const recordings: Recording[] = [
  {
    id: 'recA',
    fps: 24,
    segments: [
      { id: 'a0', frameCount: '70' },
      { id: 'a1', frameCount: '50' },
    ],
  },
  {
    id: 'recB',
    fps: 30,
    segments: [{ id: 'b0', frameCount: '7' }],
  },
  {
    id: 'recC',
    fps: 60,
    segments: [
      { id: 'c0', frameCount: '3' },
      { id: 'c1', frameCount: '9' },
    ],
  },
];

// EDL mixing 24/30/60 fps, trims cutting into frames, a split expressed as
// two adjacent trims, and a reused trim node.
const edl: EdlNode[] = [
  { id: 'sA', type: 'source', recordingId: 'recA' },
  // 24fps frame = 41666.67us; both bounds cut into frames.
  { id: 'tA', type: 'trim', node: 'sA', startUs: '1010000', endUs: '2500000' },
  { id: 'sB', type: 'source', recordingId: 'recB' },
  // 30fps frame = 33333.33us; both bounds cut into frames.
  { id: 'tB', type: 'trim', node: 'sB', startUs: '50000', endUs: '230000' },
  { id: 'sC', type: 'source', recordingId: 'recC' },
  // Split of recC at 123456us expressed as two adjacent trims.
  { id: 'tC1', type: 'trim', node: 'sC', startUs: '0', endUs: '123456' },
  { id: 'tC2', type: 'trim', node: 'sC', startUs: '123456', endUs: '200000' },
  { id: 'splitC', type: 'concat', nodes: ['tC1', 'tC2'] },
  // tA is reused: trimming must not mutate shared content.
  { id: 'root', type: 'concat', nodes: ['tA', 'tB', 'splitC', 'tA'] },
];

const timeline = build(recordings, edl, 'root');
const clips = expandEdl(recordings, edl, 'root');

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

test('duration matches the fully expanded reference', () => {
  const total = refDuration(clips);
  const dur = duration(timeline);
  const num = BigInt(dur.num);
  const den = BigInt(dur.den);
  assert.ok(den > 0n);
  assert.equal(gcd(num, den), 1n, 'duration fraction must be reduced');
  assert.equal(num * total.d, total.n * den, 'exact seconds match reference');
});

for (const fps of [24, 30, 60] as Fps[]) {
  test(`plan matches reference at ${fps}fps (full range, paginated)`, () => {
    const total = refFrameCount(clips, fps);
    checkPlanPages(timeline, fps, 0n, total + 5n, (k) => refSample(clips, fps, k));
  });

  test(`plan matches reference at ${fps}fps (offset window)`, () => {
    const total = refFrameCount(clips, fps);
    const start = total / 3n;
    const count = total / 2n;
    checkPlanPages(timeline, fps, start, count, (k) => refSample(clips, fps, k));
  });
}

test('query past the end returns empty spans and null nextFrame', () => {
  const total = refFrameCount(clips, 30);
  const res = plan(timeline, 30, (total + 10n).toString(), '100');
  assert.deepEqual(res, { spans: [], nextFrame: null });
});
