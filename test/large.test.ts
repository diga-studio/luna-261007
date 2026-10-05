import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build, duration, planExport, EdlNode, Recording, Span } from '../src/index';
import { floorSpanValue } from './reference';

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

test('80 nested doublings: paginated query near the end stays aligned', () => {
  const recordings: Recording[] = [
    { id: 'rec', fps: 24, segments: [{ id: 'S', frameCount: '3' }] },
  ];
  const edl: EdlNode[] = [{ id: 'n0', type: 'source', recordingId: 'rec' }];
  for (let i = 1; i <= 80; i++) {
    edl.push({ id: `n${i}`, type: 'concat', nodes: [`n${i - 1}`, `n${i - 1}`] });
  }
  const timeline = build(recordings, edl, 'n80');

  const dur = duration(timeline);
  assert.equal(dur.num, (1n << 77n).toString());
  assert.equal(dur.den, '1');

  const totalFrames = 3n * (1n << 80n);
  const count = 1000n;
  const start = totalFrames - count;

  const all: Span[] = [];
  let first = start;
  let pages = 0;
  for (;;) {
    const remaining = (start + count - first).toString();
    const result = planExport(timeline, 24, first.toString(), remaining);
    pages++;
    assert.ok(pages < 10, 'pagination should terminate quickly');
    if (result.nextFrame === null) {
      all.push(...result.spans);
      break;
    }
    assert.equal(result.spans.length, 128, 'only a full 128-span page may truncate');
    all.push(...result.spans);
    first = BigInt(result.nextFrame);
  }
  assert.ok(pages >= 2, 'should actually paginate');

  let expectedStart = start;
  for (const span of all) {
    assert.equal(span.startFrame, expectedStart.toString(), 'spans must be contiguous');
    assert.equal(span.recordingId, 'rec');
    assert.equal(span.segmentId, 'S');
    const a = BigInt(span.a);
    const b = BigInt(span.b);
    const d = BigInt(span.d);
    assert.ok(d > 0n);
    assert.equal(gcd3(a, b, d), 1n);
    const n = BigInt(span.frameCount);
    assert.ok(n >= 1n && n <= 3n, 'each leaf covers at most 3 output frames');
    for (let j = 0n; j < n; j++) {
      const k = expectedStart + j;
      assert.equal(floorSpanValue(a, b, d, j), k % 3n, `frame ${k} source frame`);
    }
    expectedStart += n;
  }
  assert.equal(expectedStart, totalFrames, 'coverage must reach the timeline end exactly');
});

test('exact 128-span window boundary: nextFrame null only when fully covered', () => {
  const recordings: Recording[] = [
    { id: 'rec', fps: 24, segments: [{ id: 'S', frameCount: '3' }] },
  ];
  const edl: EdlNode[] = [{ id: 'n0', type: 'source', recordingId: 'rec' }];
  for (let i = 1; i <= 80; i++) {
    edl.push({ id: `n${i}`, type: 'concat', nodes: [`n${i - 1}`, `n${i - 1}`] });
  }
  const timeline = build(recordings, edl, 'n80');
  const totalFrames = 3n * (1n << 80n);

  const exactStart = totalFrames - 384n;
  const exact = planExport(timeline, 24, exactStart.toString(), '384');
  assert.equal(exact.spans.length, 128);
  assert.equal(exact.nextFrame, null, 'window fully covered by 128 spans needs no continuation');

  const over = planExport(timeline, 24, (totalFrames - 387n).toString(), '387');
  assert.equal(over.spans.length, 128);
  assert.equal(over.nextFrame, (totalFrames - 3n).toString(), '129th span forces continuation');

  const rest = planExport(timeline, 24, over.nextFrame!, '3');
  assert.equal(rest.spans.length, 1);
  assert.equal(rest.nextFrame, null);
  assert.equal(rest.spans[0].startFrame, (totalFrames - 3n).toString());
  assert.equal(rest.spans[0].frameCount, '3');
});

test('single 1e12-frame segment plans as exactly one span', () => {
  const recordings: Recording[] = [
    { id: 'big', fps: 30, segments: [{ id: 'only', frameCount: '1000000000000' }] },
  ];
  const edl: EdlNode[] = [{ id: 'root', type: 'source', recordingId: 'big' }];
  const timeline = build(recordings, edl, 'root');

  const dur = duration(timeline);
  assert.equal(dur.num, '100000000000');
  assert.equal(dur.den, '3');

  const result = planExport(timeline, 30, '0', '1000000000000');
  assert.equal(result.nextFrame, null);
  assert.equal(result.spans.length, 1);
  const span = result.spans[0];
  assert.equal(span.startFrame, '0');
  assert.equal(span.frameCount, '1000000000000');
  assert.equal(span.recordingId, 'big');
  assert.equal(span.segmentId, 'only');
  assert.equal(span.a, '0');
  assert.equal(span.b, '1');
  assert.equal(span.d, '1');
});
