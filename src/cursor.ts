import { CompiledNode } from './compile';
import { Rat, add, cmp, max, min, sub } from './rational';

export interface Leaf {
  recordingId: string;
  segmentId: string;
  srcFps: bigint;
  srcOffset: Rat;
  occStart: Rat;
  occEnd: Rat;
}

type SourceNode = Extract<CompiledNode, { kind: 'source' }>;
type TrimNode = Extract<CompiledNode, { kind: 'trim' }>;
type ConcatNode = Extract<CompiledNode, { kind: 'concat' }>;

type Frame =
  | { kind: 'concat'; node: ConcatNode; idx: number; nodeStart: Rat; lo: Rat; hi: Rat }
  | { kind: 'trim'; node: TrimNode; nodeStart: Rat; lo: Rat; hi: Rat }
  | { kind: 'source'; node: SourceNode; segIdx: number; nodeStart: Rat; lo: Rat; hi: Rat };

export class Cursor {
  private stack: Frame[] = [];

  constructor(root: CompiledNode, at: Rat) {
    this.descend(root, { n: 0n, d: 1n }, root.total, { n: 0n, d: 1n }, at);
  }

  get done(): boolean {
    return this.stack.length === 0;
  }

  leaf(): Leaf | null {
    if (this.stack.length === 0) return null;
    const top = this.stack[this.stack.length - 1];
    if (top.kind !== 'source') throw new Error('cursor not at leaf');
    const seg = top.node.segs[top.segIdx];
    const segEnd = add(seg.start, seg.dur);
    const visStart = max(top.lo, seg.start);
    const visEnd = min(top.hi, segEnd);
    const occStart = add(top.nodeStart, sub(visStart, top.lo));
    return {
      recordingId: top.node.recordingId,
      segmentId: seg.segId,
      srcFps: top.node.srcFps,
      srcOffset: sub(visStart, seg.start),
      occStart,
      occEnd: add(occStart, sub(visEnd, visStart)),
    };
  }

  advance(): void {
    const top = this.stack[this.stack.length - 1];
    if (top.kind !== 'source') throw new Error('cursor not at leaf');
    const nextSeg = top.segIdx + 1;
    if (nextSeg < top.node.segs.length && cmp(top.node.segs[nextSeg].start, top.hi) < 0) {
      top.segIdx = nextSeg;
      return;
    }
    this.stack.pop();
    while (this.stack.length > 0) {
      const frame = this.stack[this.stack.length - 1];
      if (frame.kind === 'concat') {
        const nextChild = frame.idx + 1;
        if (
          nextChild < frame.node.children.length &&
          cmp(frame.node.starts[nextChild], frame.hi) < 0
        ) {
          frame.idx = nextChild;
          const child = frame.node.children[nextChild];
          const cs = frame.node.starts[nextChild];
          const ce = frame.node.starts[nextChild + 1];
          const childLo = sub(max(frame.lo, cs), cs);
          const childHi = sub(min(frame.hi, ce), cs);
          const childNodeStart = add(frame.nodeStart, sub(max(frame.lo, cs), frame.lo));
          this.descend(child, childLo, childHi, childNodeStart, null);
          return;
        }
      }
      this.stack.pop();
    }
  }

  private descend(node: CompiledNode, lo: Rat, hi: Rat, nodeStart: Rat, target: Rat | null): void {
    let cur = node;
    let curLo = lo;
    let curHi = hi;
    let curStart = nodeStart;
    for (;;) {
      if (cur.kind === 'source') {
        const pivot = target === null ? curLo : add(curLo, sub(target, curStart));
        const segIdx = firstSegEndingAfter(cur, pivot);
        this.stack.push({ kind: 'source', node: cur, segIdx, nodeStart: curStart, lo: curLo, hi: curHi });
        return;
      }
      if (cur.kind === 'trim') {
        this.stack.push({ kind: 'trim', node: cur, nodeStart: curStart, lo: curLo, hi: curHi });
        curLo = add(cur.start, curLo);
        curHi = add(cur.start, curHi);
        cur = cur.child;
        continue;
      }
      const pivot = target === null ? curLo : add(curLo, sub(target, curStart));
      const idx = firstChildEndingAfter(cur, pivot);
      this.stack.push({ kind: 'concat', node: cur, idx, nodeStart: curStart, lo: curLo, hi: curHi });
      const cs = cur.starts[idx];
      const ce = cur.starts[idx + 1];
      curStart = add(curStart, sub(max(curLo, cs), curLo));
      const nextLo = sub(max(curLo, cs), cs);
      curHi = sub(min(curHi, ce), cs);
      curLo = nextLo;
      cur = cur.children[idx];
    }
  }
}

function firstSegEndingAfter(node: SourceNode, t: Rat): number {
  let lo = 0;
  let hi = node.segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const seg = node.segs[mid];
    if (cmp(add(seg.start, seg.dur), t) > 0) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function firstChildEndingAfter(node: ConcatNode, t: Rat): number {
  let lo = 0;
  let hi = node.children.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cmp(node.starts[mid + 1], t) > 0) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}
