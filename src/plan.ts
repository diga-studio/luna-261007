import { ceil, cmp, gcd, mulInt, rat, add, sub } from './rational';
import { asImpl, locate } from './timeline';
import type { Fps, PlanResult, Span, Timeline } from './types';

const MAX_SPANS = 128;

export function plan(
  timeline: Timeline,
  fps: Fps,
  firstFrame: string,
  frameCount: string,
): PlanResult {
  const { root } = asImpl(timeline);
  const totalDur = root.dur;
  const outFps = BigInt(fps);
  const k0 = BigInt(firstFrame);
  const count = BigInt(frameCount);
  if (count <= 0n || k0 < 0n) {
    return { spans: [], nextFrame: null };
  }
  // Only sample times strictly earlier than the total duration.
  const lastSampled = ceil(mulInt(totalDur, outFps));
  const kEnd = k0 + count < lastSampled ? k0 + count : lastSampled;
  if (k0 >= kEnd) {
    return { spans: [], nextFrame: null };
  }

  const spans: Span[] = [];
  let kCur = k0;
  let t = rat(k0, outFps);
  while (kCur < kEnd && spans.length < MAX_SPANS) {
    if (cmp(t, totalDur) >= 0) break;
    const leaf = locate(root, totalDur, t);
    const clipFrameStart = ceil(mulInt(leaf.tlStart, outFps));
    const clipFrameEnd = ceil(mulInt(leaf.tlEnd, outFps));
    const kStart = kCur > clipFrameStart ? kCur : clipFrameStart;
    const kStop = kEnd < clipFrameEnd ? kEnd : clipFrameEnd;
    if (kStart < kStop) {
      spans.push(makeSpan(leaf, outFps, kStart, kStop));
      kCur = kStop;
    }
    t = leaf.tlEnd;
  }
  return {
    spans,
    nextFrame: kCur < kEnd ? kCur.toString() : null,
  };
}

function makeSpan(
  leaf: { recordingId: string; segmentId: string; segFps: bigint; segOffset: import('./rational').Rat; tlStart: import('./rational').Rat },
  outFps: bigint,
  kStart: bigint,
  kStop: bigint,
): Span {
  // source frame at output frame k: floor(segFps * (segOffset + k/outFps - tlStart))
  // = floor(A + k*B) with B = segFps/outFps, A = segFps*(segOffset - tlStart).
  const slope = rat(leaf.segFps, outFps);
  const intercept = add(
    mulInt(sub(leaf.segOffset, leaf.tlStart), leaf.segFps),
    mulInt(slope, kStart),
  );
  const lcm = (slope.d / gcd(slope.d, intercept.d)) * intercept.d;
  let a = intercept.n * (lcm / intercept.d);
  let b = slope.n * (lcm / slope.d);
  let d = lcm;
  const g = gcd(gcd(a < 0n ? -a : a, b), d);
  if (g > 1n) {
    a /= g;
    b /= g;
    d /= g;
  }
  return {
    firstFrame: kStart.toString(),
    frameCount: (kStop - kStart).toString(),
    recordingId: leaf.recordingId,
    segmentId: leaf.segmentId,
    a: a.toString(),
    b: b.toString(),
    d: d.toString(),
  };
}
