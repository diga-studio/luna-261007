import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build, duration, planExport, EdlNode, Recording, Span } from '../src/index';
import { expandTimeline, floorSpanValue, sampleFrames, totalOf } from './reference';

const recordings: Recording[] = [
  {
    id: 'recA',
    fps: 24,
    segments: [
      { id: 'A1', frameCount: '10' },
      { id: 'A2', frameCount: '7' },
    ],
  },
  { id: 'recB', fps: 30, segments: [{ id: 'B1', frameCount: '9' }] },
  {
    id: 'recC',
    fps: 60,
    segments: [
      { id: 'C1', frameCount: '50' },
      { id: 'C2', frameCount: '13' },
    ],
  },
];

const edl: EdlNode[] = [
  { id: 'sa', type: 'source', recordingId: 'recA' },
  { id: 'sb', type: 'source', recordingId: 'recB' },
  { id: 'sc', type: 'source', recordingId: 'recC' },
  { id: 'ta', type: 'trim', node: 'sa', startUs: '100000', endUs: '600000' },
  { id: 'tb', type: 'trim', node: 'sb', startUs: '50000', endUs: '250000' },
  { id: 'cat', type: 'concat', nodes: ['ta', 'tb', 'sc', 'ta'] },
  { id: 'root', type: 'trim', node: 'cat', startUs: '450000', endUs: '1900000' },
];

function gcd3(a: bigint, b: bigint, c: bigint): bigint {
  const g = (x: bigint, y: bigint): bigint => {
    let u = x < 0n ? -x : x;
    let v = y < 0n ? -y : y;
    while (v !== 0n) {
      const t = u % v;
      u = v;
      v = t;
    }
    return u;
  };
  return g(g(a, b), c);
}

function checkWindow(fps: 24 | 30 | 60, firstFrame: bigint, frameCount: bigint) {
  const timeline = build(recordings, edl, 'root');
  const leaves = expandTimeline(recordings, edl, 'root');
  const total = totalOf(leaves);
  const sampled = sampleFrames(leaves, total, BigInt(fps), firstFrame, frameCount);

  const result = planExport(timeline, fps, firstFrame.toString(), frameCount.toString());
  assert.equal(result.nextFrame, null, 'small timeline should not paginate');

  const expectedSpans: { startFrame: bigint; frames: { leafIndex: number; srcFrame: bigint }[] }[] = [];
  for (const s of sampled) {
    const last = expectedSpans[expectedSpans.length - 1];
    if (last && last.frames[last.frames.length - 1].leafIndex === s.leafIndex && s.frame === last.startFrame + BigInt(last.frames.length)) {
      last.frames.push(s);
    } else {
      expectedSpans.push({ startFrame: s.frame, frames: [s] });
    }
  }

  assert.equal(result.spans.length, expectedSpans.length, 'span count mismatch');
  const leavesFor = expandTimeline(recordings, edl, 'root');
  for (let i = 0; i < expectedSpans.length; i++) {
    const exp = expectedSpans[i];
    const got: Span = result.spans[i];
    assert.equal(got.startFrame, exp.startFrame.toString(), `span ${i} startFrame`);
    assert.equal(got.frameCount, exp.frames.length.toString(), `span ${i} frameCount`);
    const leaf = leavesFor[exp.frames[0].leafIndex];
    assert.equal(got.recordingId, leaf.recordingId, `span ${i} recordingId`);
    assert.equal(got.segmentId, leaf.segmentId, `span ${i} segmentId`);
    const a = BigInt(got.a);
    const b = BigInt(got.b);
    const d = BigInt(got.d);
    assert.ok(d > 0n, `span ${i} d must be positive`);
    assert.equal(gcd3(a, b, d), 1n, `span ${i} gcd(a,b,d) must be 1`);
    for (let j = 0n; j < BigInt(exp.frames.length); j++) {
      const expected = exp.frames[Number(j)].srcFrame;
      const actual = floorSpanValue(a, b, d, j);
      assert.equal(actual, expected, `span ${i} frame ${j} source frame`);
    }
  }
}

test('duration matches fully expanded reference', () => {
  const timeline = build(recordings, edl, 'root');
  const leaves = expandTimeline(recordings, edl, 'root');
  const total = totalOf(leaves);
  const dur = duration(timeline);
  assert.equal(dur.num, total.n.toString());
  assert.equal(dur.den, total.d.toString());
});

test('full-timeline query at 30fps matches reference frame by frame', () => {
  checkWindow(30, 0n, 10000n);
});

test('full-timeline query at 60fps matches reference frame by frame', () => {
  checkWindow(60, 0n, 10000n);
});

test('mid-timeline window at 24fps matches reference', () => {
  checkWindow(24, 7n, 23n);
});

test('window starting past the end yields no spans and null nextFrame', () => {
  const timeline = build(recordings, edl, 'root');
  const result = planExport(timeline, 30, '999999', '10');
  assert.deepEqual(result.spans, []);
  assert.equal(result.nextFrame, null);
});

test('trim does not mutate shared node content', () => {
  const timeline = build(recordings, edl, 'cat');
  const leaves = expandTimeline(recordings, edl, 'cat');
  const total = totalOf(leaves);
  const dur = duration(timeline);
  assert.equal(dur.num, total.n.toString());
  assert.equal(dur.den, total.d.toString());
  const again = planExport(build(recordings, edl, 'root'), 30, '0', '10000');
  const first = planExport(build(recordings, edl, 'root'), 30, '0', '10000');
  assert.deepEqual(again, first);
});
