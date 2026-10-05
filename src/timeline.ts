import {
  Rat, ZERO, rat, add, sub, mulInt, cmp, min, max,
} from './rational';
import type { EdlNode, ExactDuration, Recording, Timeline } from './types';

const MICROS_PER_SECOND = 1000000n;

/** One occurrence of a valid source segment inside the conceptual expansion. */
export interface Leaf {
  /** Absolute timeline seconds where this occurrence starts. */
  tlStart: Rat;
  /** Absolute timeline seconds where this occurrence ends. */
  tlEnd: Rat;
  recordingId: string;
  segmentId: string;
  segFps: bigint;
  /** Source seconds (within the segment) corresponding to tlStart. */
  segOffset: Rat;
}

interface SourceCompiled {
  kind: 'source';
  recordingId: string;
  segFps: bigint;
  segIds: string[];
  /** Content-time offsets in seconds, length segIds.length + 1. */
  segPrefix: Rat[];
  segDur: Rat[];
  dur: Rat;
}

interface TrimCompiled {
  kind: 'trim';
  child: Compiled;
  /** Trim start in child content seconds. */
  start: Rat;
  dur: Rat;
}

interface ConcatCompiled {
  kind: 'concat';
  children: Compiled[];
  /** Content-time offsets in seconds, length children.length + 1. */
  prefix: Rat[];
  dur: Rat;
}

type Compiled = SourceCompiled | TrimCompiled | ConcatCompiled;

export interface TimelineImpl {
  root: Compiled;
}

export function asImpl(timeline: Timeline): TimelineImpl {
  return timeline as unknown as TimelineImpl;
}

/** Index of the interval containing u: first i with prefix[i+1] > u. */
function findInterval(prefix: Rat[], u: Rat): number {
  let lo = 0;
  let hi = prefix.length - 1; // search over interval indices [0, hi)
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const end = prefix[mid + 1];
    if (end !== undefined && cmp(end, u) > 0) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  return lo;
}

/**
 * Locate the leaf occurrence containing absolute time t.
 * shift: absTime = nodeContentTime + shift. [visStart, visEnd): visible abs window.
 */
export function locate(root: Compiled, totalDur: Rat, t: Rat): Leaf {
  let node = root;
  let shift = ZERO;
  let visStart = ZERO;
  let visEnd = totalDur;
  for (;;) {
    if (node.kind === 'source') {
      const u = sub(t, shift);
      const i = findInterval(node.segPrefix, u);
      const segStartContent = node.segPrefix[i];
      const segDur = node.segDur[i];
      if (segStartContent === undefined || segDur === undefined) {
        throw new Error('segment index out of range');
      }
      const segStart = add(shift, segStartContent);
      const tlStart = max(segStart, visStart);
      const tlEnd = min(add(segStart, segDur), visEnd);
      return {
        tlStart,
        tlEnd,
        recordingId: node.recordingId,
        segmentId: node.segIds[i] ?? '',
        segFps: node.segFps,
        segOffset: sub(tlStart, segStart),
      };
    }
    if (node.kind === 'trim') {
      const childShift = sub(shift, node.start);
      const nextVisStart = max(visStart, shift);
      const nextVisEnd = min(visEnd, add(shift, node.dur));
      node = node.child;
      shift = childShift;
      visStart = nextVisStart;
      visEnd = nextVisEnd;
      continue;
    }
    const u = sub(t, shift);
    const i = findInterval(node.prefix, u);
    const childStart = node.prefix[i];
    const childEnd = node.prefix[i + 1];
    const child = node.children[i];
    if (childStart === undefined || childEnd === undefined || child === undefined) {
      throw new Error('concat child index out of range');
    }
    const childShift = add(shift, childStart);
    const nextVisStart = max(visStart, childShift);
    const nextVisEnd = min(visEnd, add(shift, childEnd));
    node = child;
    shift = childShift;
    visStart = nextVisStart;
    visEnd = nextVisEnd;
  }
}

export function build(recordings: Recording[], edl: EdlNode[], rootId: string): Timeline {
  const recById = new Map<string, Recording>();
  for (const rec of recordings) {
    if (recById.has(rec.id)) throw new Error(`duplicate recording id: ${rec.id}`);
    recById.set(rec.id, rec);
  }
  const nodeById = new Map<string, EdlNode>();
  for (const node of edl) {
    if (nodeById.has(node.id)) throw new Error(`duplicate edl node id: ${node.id}`);
    nodeById.set(node.id, node);
  }
  const memo = new Map<string, Compiled>();
  const compile = (id: string): Compiled => {
    const hit = memo.get(id);
    if (hit) return hit;
    const node = nodeById.get(id);
    if (node === undefined) throw new Error(`unknown edl node: ${id}`);
    let compiled: Compiled;
    if (node.type === 'source') {
      const rec = recById.get(node.recordingId);
      if (rec === undefined) throw new Error(`unknown recording: ${node.recordingId}`);
      const segFps = BigInt(rec.fps);
      const segPrefix: Rat[] = [ZERO];
      const segDur: Rat[] = [];
      const segIds: string[] = [];
      let acc = ZERO;
      for (const seg of rec.segments) {
        const frames = BigInt(seg.frameCount);
        if (frames <= 0n) throw new Error(`non-positive frameCount in segment ${seg.id}`);
        const dur = rat(frames, segFps);
        segIds.push(seg.id);
        segDur.push(dur);
        acc = add(acc, dur);
        segPrefix.push(acc);
      }
      compiled = { kind: 'source', recordingId: rec.id, segFps, segIds, segPrefix, segDur, dur: acc };
    } else if (node.type === 'trim') {
      const child = compile(node.node);
      const start = rat(BigInt(node.startUs), MICROS_PER_SECOND);
      const end = rat(BigInt(node.endUs), MICROS_PER_SECOND);
      if (cmp(start, ZERO) < 0 || cmp(end, start) <= 0 || cmp(end, child.dur) > 0) {
        throw new Error(`invalid trim interval on node ${node.id}`);
      }
      compiled = { kind: 'trim', child, start, dur: sub(end, start) };
    } else {
      const children = node.nodes.map(compile);
      if (children.length === 0) throw new Error(`empty concat node ${node.id}`);
      const prefix: Rat[] = [ZERO];
      let acc = ZERO;
      for (const child of children) {
        acc = add(acc, child.dur);
        prefix.push(acc);
      }
      compiled = { kind: 'concat', children, prefix, dur: acc };
    }
    memo.set(id, compiled);
    return compiled;
  };
  const root = compile(rootId);
  return { root } as unknown as Timeline;
}

export function duration(timeline: Timeline): ExactDuration {
  const { root } = asImpl(timeline);
  return { num: root.dur.n.toString(), den: root.dur.d.toString() };
}
