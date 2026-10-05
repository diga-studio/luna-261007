import { Cursor } from './cursor';
import { ceilDiv, cmp, mul, mulInt, rat, sub } from './rational';
import { Fps, PlanResult, Span, Timeline } from './types';

export const MAX_SPANS = 128;

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

export function plan(timeline: Timeline, fps: Fps, firstFrame: string, frameCount: string): PlanResult {
  const outFps = BigInt(fps);
  const qStart = BigInt(firstFrame);
  const qLen = BigInt(frameCount);

  const totalFrames = ceilDiv(timeline.totalSeconds.n * outFps, timeline.totalSeconds.d);
  const winStart = qStart < 0n ? 0n : qStart;
  const tentativeEnd = qStart + qLen;
  const winEnd = tentativeEnd < totalFrames ? tentativeEnd : totalFrames;

  const spans: Span[] = [];
  if (winStart >= winEnd || qLen <= 0n) {
    return { spans, nextFrame: null };
  }

  const winEndRat = rat(winEnd, 1n);
  const cursor = new Cursor(timeline.root, rat(winStart, outFps));

  while (!cursor.done) {
    const leaf = cursor.leaf()!;
    if (cmp(mulInt(leaf.occStart, outFps), winEndRat) >= 0) break;

    const leafF0 = ceilDiv(leaf.occStart.n * outFps, leaf.occStart.d);
    const leafF1 = ceilDiv(leaf.occEnd.n * outFps, leaf.occEnd.d);
    const f0 = leafF0 > winStart ? leafF0 : winStart;
    const f1 = leafF1 < winEnd ? leafF1 : winEnd;

    if (f0 < f1) {
      const base = mul(sub(leaf.srcOffset, leaf.occStart), rat(leaf.srcFps, 1n));
      const g = gcd(leaf.srcFps, outFps);
      const b = leaf.srcFps / g;
      const dd = outFps / g;
      const g1 = gcd(base.d, dd);
      const q = base.d / g1;
      const dPrime = dd / g1;
      const rawA = base.n * dPrime + f0 * b * q;
      const rawB = b * q;
      const rawD = q * dd;
      const gAll = gcd(gcd(rawA, rawB), rawD);
      spans.push({
        startFrame: f0.toString(),
        frameCount: (f1 - f0).toString(),
        recordingId: leaf.recordingId,
        segmentId: leaf.segmentId,
        a: (rawA / gAll).toString(),
        b: (rawB / gAll).toString(),
        d: (rawD / gAll).toString(),
      });
      if (f1 >= winEnd) return { spans, nextFrame: null };
      if (spans.length === MAX_SPANS) return { spans, nextFrame: f1.toString() };
    }
    cursor.advance();
  }
  return { spans, nextFrame: null };
}
