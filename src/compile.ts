import { EdlNode, Recording } from './types';
import { Rat, add, rat } from './rational';

export interface SourceSeg {
  segId: string;
  start: Rat;
  dur: Rat;
}

export type CompiledNode =
  | { kind: 'source'; recordingId: string; srcFps: bigint; segs: SourceSeg[]; total: Rat }
  | { kind: 'trim'; child: CompiledNode; start: Rat; end: Rat; total: Rat }
  | { kind: 'concat'; children: CompiledNode[]; starts: Rat[]; total: Rat };

const MICROS_PER_SECOND = 1_000_000n;

export function compile(recordings: Recording[], edl: EdlNode[], rootId: string): CompiledNode {
  const recById = new Map<string, Recording>();
  for (const rec of recordings) {
    if (recById.has(rec.id)) throw new Error(`duplicate recording id: ${rec.id}`);
    recById.set(rec.id, rec);
  }

  const compiled = new Map<string, CompiledNode>();
  for (const node of edl) {
    if (compiled.has(node.id)) throw new Error(`duplicate edl node id: ${node.id}`);
    compiled.set(node.id, compileNode(node, recById, compiled));
  }

  const root = compiled.get(rootId);
  if (!root) throw new Error(`unknown root id: ${rootId}`);
  return root;
}

function compileNode(
  node: EdlNode,
  recById: Map<string, Recording>,
  compiled: Map<string, CompiledNode>,
): CompiledNode {
  switch (node.type) {
    case 'source': {
      const rec = recById.get(node.recordingId);
      if (!rec) throw new Error(`unknown recording: ${node.recordingId}`);
      const fps = BigInt(rec.fps);
      const segs: SourceSeg[] = [];
      let acc = rat(0n, 1n);
      for (const seg of rec.segments) {
        const frameCount = BigInt(seg.frameCount);
        if (frameCount <= 0n) throw new Error(`non-positive frameCount in segment ${seg.id}`);
        const dur = rat(frameCount, fps);
        segs.push({ segId: seg.id, start: acc, dur });
        acc = add(acc, dur);
      }
      return { kind: 'source', recordingId: rec.id, srcFps: fps, segs, total: acc };
    }
    case 'trim': {
      const child = compiled.get(node.node);
      if (!child) throw new Error(`unknown trim target: ${node.node}`);
      const start = rat(BigInt(node.startUs), MICROS_PER_SECOND);
      const end = rat(BigInt(node.endUs), MICROS_PER_SECOND);
      return { kind: 'trim', child, start, end, total: sub0(end, start) };
    }
    case 'concat': {
      const children: CompiledNode[] = [];
      const starts: Rat[] = [];
      let acc = rat(0n, 1n);
      for (const childId of node.nodes) {
        const child = compiled.get(childId);
        if (!child) throw new Error(`unknown concat child: ${childId}`);
        children.push(child);
        starts.push(acc);
        acc = add(acc, child.total);
      }
      starts.push(acc);
      return { kind: 'concat', children, starts, total: acc };
    }
  }
}

function sub0(a: Rat, b: Rat): Rat {
  return rat(a.n * b.d - b.n * a.d, a.d * b.d);
}
