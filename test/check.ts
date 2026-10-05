// Paginated plan verification: runs plan() page by page and checks every
// output frame against an independent per-frame expectation.
import * as assert from 'node:assert/strict';
import { plan } from '../src/index';
import type { Fps, Timeline } from '../src/index';

export interface Expected {
  recordingId: string;
  segmentId: string;
  sourceFrame: bigint;
}

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

export function checkPlanPages(
  timeline: Timeline,
  fps: Fps,
  firstFrame: bigint,
  frameCount: bigint,
  expect: (k: bigint) => Expected | null,
): void {
  const end = firstFrame + frameCount;
  // Expected coverage must be a contiguous prefix.
  let expectedFrames = 0n;
  for (let k = firstFrame; k < end; k++) {
    if (expect(k) === null) break;
    expectedFrames++;
  }
  let cursor = firstFrame;
  let pages = 0;
  for (;;) {
    pages++;
    const res = plan(timeline, fps, cursor.toString(), (end - cursor).toString());
    assert.ok(res.spans.length <= 128, 'at most 128 spans per page');
    if (cursor < firstFrame + expectedFrames) {
      assert.ok(res.spans.length > 0, 'must make progress while frames remain');
    } else {
      assert.equal(res.spans.length, 0, 'no spans past the end');
      assert.equal(res.nextFrame, null);
      break;
    }
    for (const span of res.spans) {
      const spanStart = BigInt(span.firstFrame);
      const spanFrames = BigInt(span.frameCount);
      assert.equal(spanStart, cursor, 'spans must be contiguous');
      assert.ok(spanFrames > 0n, 'no empty spans');
      const a = BigInt(span.a);
      const b = BigInt(span.b);
      const d = BigInt(span.d);
      assert.ok(d > 0n, 'd must be positive');
      assert.equal(gcd3(a, b, d), 1n, 'gcd(a,b,d) must be 1');
      for (let j = 0n; j < spanFrames; j++) {
        const k = spanStart + j;
        const exp = expect(k);
        assert.ok(exp !== null, `frame ${k} must be within the timeline`);
        assert.equal(span.recordingId, exp.recordingId, `frame ${k} recording`);
        assert.equal(span.segmentId, exp.segmentId, `frame ${k} segment`);
        const got = (a + j * b) / d; // floor: a+j*b >= 0 here
        assert.ok(a + j * b >= 0n, 'source frame numerator must be non-negative');
        assert.equal(got, exp.sourceFrame, `frame ${k} source frame`);
      }
      cursor = spanStart + spanFrames;
    }
    if (res.nextFrame === null) {
      assert.equal(cursor, firstFrame + expectedFrames, 'full prefix covered');
      break;
    }
    assert.equal(BigInt(res.nextFrame), cursor, 'nextFrame is the resume point');
  }
  assert.equal(cursor, firstFrame + expectedFrames, 'coverage matches expectation');
}
