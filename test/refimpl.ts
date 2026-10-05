// Independent reference implementation: fully expands the EDL into a flat
// clip list and samples frame by frame. Only usable for small timelines.
import type { EdlNode, Fps, Recording } from '../src/index';

// Minimal standalone fraction (no normalization; compare by cross multiply).
interface Frac {
  n: bigint;
  d: bigint; // always > 0
}

function frac(n: bigint, d: bigint = 1n): Frac {
  if (d < 0n) return { n: -n, d: -d };
  return { n, d };
}

function fadd(a: Frac, b: Frac): Frac {
  return frac(a.n * b.d + b.n * a.d, a.d * b.d);
}

function fsub(a: Frac, b: Frac): Frac {
  return frac(a.n * b.d - b.n * a.d, a.d * b.d);
}

function fcmp(a: Frac, b: Frac): number {
  const lhs = a.n * b.d;
  const rhs = b.n * a.d;
  return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
}

function ffloor(a: Frac): bigint {
  const q = a.n / a.d;
  return a.n % a.d === 0n ? q : a.n < 0n ? q - 1n : q;
}

export interface RefClip {
  recordingId: string;
  segmentId: string;
  segFps: bigint;
  /** Seconds from timeline zero to this clip occurrence start. */
  tlStart: Frac;
  /** Clip duration in seconds. */
  dur: Frac;
  /** Source seconds (within the segment) at tlStart. */
  srcOffset: Frac;
}

export function expandEdl(
  recordings: Recording[],
  edl: EdlNode[],
  rootId: string,
): RefClip[] {
  const recById = new Map(recordings.map((r) => [r.id, r]));
  const nodeById = new Map(edl.map((n) => [n.id, n]));

  const expand = (id: string): RefClip[] => {
    const node = nodeById.get(id);
    if (node === undefined) throw new Error(`unknown node ${id}`);
    if (node.type === 'source') {
      const rec = recById.get(node.recordingId);
      if (rec === undefined) throw new Error(`unknown recording ${node.recordingId}`);
      const clips: RefClip[] = [];
      let acc = frac(0n);
      for (const seg of rec.segments) {
        const dur = frac(BigInt(seg.frameCount), BigInt(rec.fps));
        clips.push({
          recordingId: rec.id,
          segmentId: seg.id,
          segFps: BigInt(rec.fps),
          tlStart: acc,
          dur,
          srcOffset: frac(0n),
        });
        acc = fadd(acc, dur);
      }
      return clips;
    }
    if (node.type === 'trim') {
      const start = frac(BigInt(node.startUs), 1000000n);
      const end = frac(BigInt(node.endUs), 1000000n);
      const out: RefClip[] = [];
      for (const clip of expand(node.node)) {
        const clipEnd = fadd(clip.tlStart, clip.dur);
        const ovStart = fcmp(clip.tlStart, start) > 0 ? clip.tlStart : start;
        const ovEnd = fcmp(clipEnd, end) < 0 ? clipEnd : end;
        if (fcmp(ovStart, ovEnd) < 0) {
          out.push({
            recordingId: clip.recordingId,
            segmentId: clip.segmentId,
            segFps: clip.segFps,
            tlStart: fsub(ovStart, start),
            dur: fsub(ovEnd, ovStart),
            srcOffset: fadd(clip.srcOffset, fsub(ovStart, clip.tlStart)),
          });
        }
      }
      return out;
    }
    const out: RefClip[] = [];
    let acc = frac(0n);
    for (const childId of node.nodes) {
      const childClips = expand(childId);
      let childDur = frac(0n);
      for (const clip of childClips) {
        out.push({ ...clip, tlStart: fadd(clip.tlStart, acc) });
        childDur = fadd(childDur, clip.dur);
      }
      acc = fadd(acc, childDur);
    }
    return out;
  };
  return expand(rootId);
}

export function refDuration(clips: RefClip[]): Frac {
  let acc = frac(0n);
  for (const clip of clips) acc = fadd(acc, clip.dur);
  return acc;
}

export interface RefSample {
  recordingId: string;
  segmentId: string;
  sourceFrame: bigint;
}

/** Sample output frame k at k/fps seconds; null when at/after the end. */
export function refSample(clips: RefClip[], fps: Fps, k: bigint): RefSample | null {
  const t = frac(k, BigInt(fps));
  for (const clip of clips) {
    const clipEnd = fadd(clip.tlStart, clip.dur);
    if (fcmp(clip.tlStart, t) <= 0 && fcmp(t, clipEnd) < 0) {
      const srcTime = fadd(clip.srcOffset, fsub(t, clip.tlStart));
      const frame = ffloor(frac(srcTime.n * clip.segFps, srcTime.d));
      return { recordingId: clip.recordingId, segmentId: clip.segmentId, sourceFrame: frame };
    }
  }
  return null;
}

/** Number of output frames: those with k/fps strictly before the end. */
export function refFrameCount(clips: RefClip[], fps: Fps): bigint {
  const total = refDuration(clips);
  const scaled = frac(total.n * BigInt(fps), total.d);
  const q = scaled.n / scaled.d;
  return scaled.n % scaled.d === 0n ? q : q + 1n;
}
