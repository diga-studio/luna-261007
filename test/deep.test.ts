import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { build, duration, plan } from '../src/index';
import type { EdlNode, Recording } from '../src/index';
import { checkPlanPages } from './check';

// 80 nested doubling concats over a 3-frame 30fps segment (0.1s each leaf):
// total duration = 2^80 * 0.1s, total output frames at 30fps = 3 * 2^80 > 2^80.
const recordings: Recording[] = [
  { id: 'rec', fps: 30, segments: [{ id: 'seg', frameCount: '3' }] },
];
const edl: EdlNode[] = [{ id: 'n0', type: 'source', recordingId: 'rec' }];
for (let i = 1; i <= 80; i++) {
  edl.push({ id: `n${i}`, type: 'concat', nodes: [`n${i - 1}`, `n${i - 1}`] });
}
const timeline = build(recordings, edl, 'n80');

const TWO80 = 1n << 80n;
const TOTAL_FRAMES = 3n * TWO80; // at 30fps output

// Every leaf is the full 3-frame segment: output frame k maps to source
// frame k mod 3 of the only segment.
const expectFrame = (k: bigint) =>
  k < TOTAL_FRAMES
    ? { recordingId: 'rec', segmentId: 'seg', sourceFrame: k % 3n }
    : null;

test('duration is exactly 2^79/5 seconds', () => {
  const dur = duration(timeline);
  assert.equal(dur.num, (TWO80 / 2n).toString());
  assert.equal(dur.den, '5');
});

test('query near the end, paginated, no drift or gaps', () => {
  const firstFrame = TOTAL_FRAMES - 1000n;
  checkPlanPages(timeline, 30, firstFrame, 2000n, expectFrame);
});

test('query from the middle stays aligned', () => {
  const firstFrame = TOTAL_FRAMES / 2n + 7n;
  checkPlanPages(timeline, 30, firstFrame, 500n, expectFrame);
});

test('last page ends exactly at the timeline end', () => {
  const res = plan(timeline, 30, (TOTAL_FRAMES - 2n).toString(), '10');
  assert.equal(res.nextFrame, null);
  const covered = res.spans.reduce((acc, s) => acc + BigInt(s.frameCount), 0n);
  assert.equal(covered, 2n);
});
