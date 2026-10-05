import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { build, duration, plan } from '../src/index';
import type { EdlNode, Recording } from '../src/index';

// One continuous 10^12-frame 24fps segment; metadata only, no media.
const FRAMES = 10n ** 12n;
const recordings: Recording[] = [
  { id: 'rec', fps: 24, segments: [{ id: 'seg', frameCount: FRAMES.toString() }] },
];
const edl: EdlNode[] = [{ id: 'src', type: 'source', recordingId: 'rec' }];
const timeline = build(recordings, edl, 'src');

test('duration is exact', () => {
  const dur = duration(timeline);
  // 10^12 / 24 = 125000000000/3
  assert.equal(dur.num, '125000000000');
  assert.equal(dur.den, '3');
});

test('whole-range query at native fps returns a single span', () => {
  const res = plan(timeline, 24, '0', FRAMES.toString());
  assert.equal(res.nextFrame, null);
  assert.equal(res.spans.length, 1);
  const span = res.spans[0];
  assert.ok(span !== undefined);
  assert.equal(span.firstFrame, '0');
  assert.equal(span.frameCount, FRAMES.toString());
  assert.equal(span.recordingId, 'rec');
  assert.equal(span.segmentId, 'seg');
  assert.equal(span.a, '0');
  assert.equal(span.b, '1');
  assert.equal(span.d, '1');
});

test('whole-range query at 60fps returns a single span', () => {
  const total = (FRAMES * 60n) / 24n; // 2.5 * 10^12, exact
  const res = plan(timeline, 60, '0', total.toString());
  assert.equal(res.nextFrame, null);
  assert.equal(res.spans.length, 1);
  const span = res.spans[0];
  assert.ok(span !== undefined);
  assert.equal(span.frameCount, total.toString());
  // source frame = floor(k * 24/60) = floor(k * 2/5)
  assert.equal(span.a, '0');
  assert.equal(span.b, '2');
  assert.equal(span.d, '5');
});

test('mid-range window is still a single span', () => {
  const res = plan(timeline, 24, '1000000', '999999999');
  assert.equal(res.nextFrame, null);
  assert.equal(res.spans.length, 1);
  const span = res.spans[0];
  assert.ok(span !== undefined);
  assert.equal(span.firstFrame, '1000000');
  assert.equal(span.frameCount, '999999999');
  assert.equal(span.a, '1000000');
  assert.equal(span.b, '1');
  assert.equal(span.d, '1');
});
