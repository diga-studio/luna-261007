import { EdlNode, Recording } from '../src/types';
import { Rat, add, ceilDiv, cmp, floorDiv, rat, sub } from '../src/rational';

export interface RefLeaf {
  recordingId: string;
  segmentId: string;
  srcFps: bigint;
  srcOffset: Rat;
  occStart: Rat;
  dur: Rat;
}

export function expandTimeline(recordings: Recording[], edl: EdlNode[], rootId: string): RefLeaf[] {
  const recMap = new Map(recordings.map((r) => [r.id, r]));
  const nodeMap = new Map(edl.map((n) => [n.id, n]));

  const expand = (id: string): RefLeaf[] => {
    const node = nodeMap.get(id);
    if (!node) throw new Error(`unknown node ${id}`);
    if (node.type === 'source') {
      const rec = recMap.get(node.recordingId)!;
      const fps = BigInt(rec.fps);
      let t = rat(0n, 1n);
      const out: RefLeaf[] = [];
      for (const seg of rec.segments) {
        const dur = rat(BigInt(seg.frameCount), fps);
        out.push({
          recordingId: rec.id,
          segmentId: seg.id,
          srcFps: fps,
          srcOffset: rat(0n, 1n),
          occStart: t,
          dur,
        });
        t = add(t, dur);
      }
      return out;
    }
    if (node.type === 'trim') {
      const s = rat(BigInt(node.startUs), 1_000_000n);
      const e = rat(BigInt(node.endUs), 1_000_000n);
      const out: RefLeaf[] = [];
      for (const leaf of expand(node.node)) {
        const leafEnd = add(leaf.occStart, leaf.dur);
        const vs = cmp(leaf.occStart, s) > 0 ? leaf.occStart : s;
        const ve = cmp(leafEnd, e) < 0 ? leafEnd : e;
        if (cmp(vs, ve) < 0) {
          out.push({
            ...leaf,
            srcOffset: add(leaf.srcOffset, sub(vs, leaf.occStart)),
            occStart: sub(vs, s),
            dur: sub(ve, vs),
          });
        }
      }
      return out;
    }
    const out: RefLeaf[] = [];
    let t = rat(0n, 1n);
    for (const childId of node.nodes) {
      const childLeaves = expand(childId);
      for (const leaf of childLeaves) {
        out.push({ ...leaf, occStart: add(leaf.occStart, t) });
      }
      for (const leaf of childLeaves) {
        t = add(t, leaf.dur);
      }
    }
    return out;
  };

  return expand(rootId);
}

export function totalOf(leaves: RefLeaf[]): Rat {
  let t = rat(0n, 1n);
  for (const leaf of leaves) t = add(t, leaf.dur);
  return t;
}

export interface SampledFrame {
  frame: bigint;
  leafIndex: number;
  srcFrame: bigint;
}

export function sampleFrames(
  leaves: RefLeaf[],
  total: Rat,
  fps: bigint,
  firstFrame: bigint,
  frameCount: bigint,
): SampledFrame[] {
  const totalFrames = ceilDiv(total.n * fps, total.d);
  let end = firstFrame + frameCount;
  if (end > totalFrames) end = totalFrames;
  const out: SampledFrame[] = [];
  let li = 0;
  for (let k = firstFrame; k < end; k++) {
    const t = rat(k, fps);
    while (li < leaves.length - 1 && cmp(add(leaves[li].occStart, leaves[li].dur), t) <= 0) li++;
    const leaf = leaves[li];
    const srcTime = add(leaf.srcOffset, sub(t, leaf.occStart));
    const srcFrame = floorDiv(srcTime.n * leaf.srcFps, srcTime.d);
    out.push({ frame: k, leafIndex: li, srcFrame });
  }
  return out;
}

export function floorSpanValue(a: bigint, b: bigint, d: bigint, j: bigint): bigint {
  return floorDiv(a + j * b, d);
}
