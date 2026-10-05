import type { Rule } from './types';
import { cidrToRange } from './ipv4';

const PORT_SPACE = 65536; // 端口取值 0..65535，上界哨兵为 65536
const NO_RULE = 0xffffffff;

// 事件打包：pos(0..65536, 17 位) << 12 | isAdd(1 位) << 11 | rank(<=2047, 11 位)
const EVENT_POS_SHIFT = 12;
const EVENT_ADD_BIT = 1 << 11;

/** 简单二叉最小堆（存规则名次，名次小者胜出），配合懒删除 */
class MinHeap {
  private data: number[] = [];
  size(): number {
    return this.data.length;
  }
  push(v: number): void {
    const a = this.data;
    a.push(v);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p] <= a[i]) break;
      const t = a[p];
      a[p] = a[i];
      a[i] = t;
      i = p;
    }
  }
  top(): number {
    return this.data[0];
  }
  clear(): void {
    this.data.length = 0;
  }
  pop(): void {
    const a = this.data;
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l] < a[m]) m = l;
        if (r < a.length && a[r] < a[m]) m = r;
        if (m === i) break;
        const t = a[m];
        a[m] = a[i];
        a[i] = t;
        i = m;
      }
    }
  }
}

/**
 * 单一记录协议（TCP/UDP/ICMP）的裁决索引。
 *
 * 结构：把所有规则网段边界切开成互不相交的网段，每个网段内匹配的规则集合恒定；
 * 对每段再用端口区间端点切分，预计算每个端口子区间的获胜规则（按优先级、编号排序后的首个覆盖者）。
 * 查询 = 两次二分查找。构建过程使用扁平类型数组，避免大量临时对象。
 */
export class ProtocolIndex {
  private readonly hasPort: boolean;

  // 网段起始地址（升序）；网段 i 覆盖 [segBounds[i], segBounds[i+1])
  private segBounds: number[] = [];
  // 每个网段在端口胜者表中的起始下标（长度 = 网段数 + 1）
  private segOffset: Uint32Array = new Uint32Array(0);
  // 端口胜者表：entryStart[i] 起的端口区间获胜规则为 entryRule[i]（规则数组下标）
  private entryStart: Uint32Array = new Uint32Array(0);
  private entryRule: Uint32Array = new Uint32Array(0);

  /** hasPort=false 时（ICMP）只有端口条件为任意的规则参与 */
  constructor(hasPort: boolean) {
    this.hasPort = hasPort;
  }

  build(rules: Rule[]): void {
    // 候选规则：ICMP 组只保留端口任意的规则
    const candidates: number[] = [];
    for (let i = 0; i < rules.length; i++) {
      if (this.hasPort || rules[i].port.kind === 'any') {
        candidates.push(i);
      }
    }
    // 按 (priority, id) 升序，名次即胜出顺序
    candidates.sort(
      (a, b) => rules[a].priority - rules[b].priority || rules[a].id - rules[b].id,
    );

    if (candidates.length === 0) {
      this.segBounds = [];
      this.segOffset = new Uint32Array(0);
      this.entryStart = new Uint32Array(0);
      this.entryRule = new Uint32Array(0);
      return;
    }

    const n = candidates.length;
    const rangeStart = new Float64Array(n);
    const rangeEnd = new Float64Array(n);
    const boundSet = new Set<number>();
    for (let rank = 0; rank < n; rank++) {
      const [s, e] = cidrToRange(rules[candidates[rank]].cidr);
      rangeStart[rank] = s;
      rangeEnd[rank] = e;
      boundSet.add(s);
      boundSet.add(e + 1);
    }
    const bounds = Array.from(boundSet).sort((a, b) => a - b);
    const segCount = bounds.length - 1;

    // 每个网段覆盖的规则名次列表，扁平存储：covered[segCoverOff[seg] .. segCoverOff[seg+1])
    const segCoverOff = new Uint32Array(segCount + 1);
    for (let rank = 0; rank < n; rank++) {
      const lo = lowerBound(bounds, rangeStart[rank]);
      const hi = lowerBound(bounds, rangeEnd[rank] + 1);
      for (let seg = lo; seg < hi; seg++) {
        segCoverOff[seg + 1]++;
      }
    }
    for (let seg = 0; seg < segCount; seg++) {
      segCoverOff[seg + 1] += segCoverOff[seg];
    }
    const covered = new Uint32Array(segCoverOff[segCount]);
    {
      const cursor = Uint32Array.from(segCoverOff);
      for (let rank = 0; rank < n; rank++) {
        const lo = lowerBound(bounds, rangeStart[rank]);
        const hi = lowerBound(bounds, rangeEnd[rank] + 1);
        for (let seg = lo; seg < hi; seg++) {
          covered[cursor[seg]++] = rank;
        }
      }
    }

    // 每个网段构建端口胜者表
    const segOffset = new Uint32Array(segCount + 1);
    let allStarts: number[] = [];
    let allRules: number[] = [];
    const heap = new MinHeap();
    const removed = new Uint8Array(n);
    // 事件缓冲区跨网段复用，避免反复分配
    const eventBuf = new Uint32Array(n * 2);
    for (let seg = 0; seg < segCount; seg++) {
      segOffset[seg] = allStarts.length;
      const from = segCoverOff[seg];
      const to = segCoverOff[seg + 1];
      const k = to - from;
      if (k === 0) continue;

      if (!this.hasPort) {
        // ICMP：覆盖规则均可匹配（已过滤为端口任意），取名次第一
        allStarts.push(0);
        allRules.push(candidates[covered[from]]);
        continue;
      }

      // 端口扫描线：打包事件存入扁平数组后排序
      const events = eventBuf.subarray(0, k * 2);
      for (let j = 0; j < k; j++) {
        const rank = covered[from + j];
        const p = rules[candidates[rank]].port;
        const lo = p.kind === 'any' ? 0 : p.from;
        const hi = p.kind === 'any' ? PORT_SPACE - 1 : p.to;
        events[j * 2] = (lo << EVENT_POS_SHIFT) | EVENT_ADD_BIT | rank;
        events[j * 2 + 1] = ((hi + 1) << EVENT_POS_SHIFT) | rank;
      }
      events.sort();

      heap.clear();
      removed.fill(0);
      let cursor = 0;
      let lastWinner = -2;
      const settle = (pos: number): void => {
        if (pos <= cursor) return;
        while (heap.size() > 0 && removed[heap.top()]) heap.pop();
        const winner = heap.size() > 0 ? candidates[heap.top()] : -1;
        if (winner !== lastWinner) {
          allStarts.push(cursor);
          allRules.push(winner);
          lastWinner = winner;
        }
        cursor = pos;
      };
      for (let j = 0; j < events.length; j++) {
        const ev = events[j];
        const pos = ev >>> EVENT_POS_SHIFT;
        settle(pos);
        const rank = ev & (EVENT_ADD_BIT - 1);
        if (ev & EVENT_ADD_BIT) heap.push(rank);
        else removed[rank] = 1;
      }
      // 结算最后一个事件之后的剩余端口区间（通常无胜者）
      settle(PORT_SPACE);
    }
    segOffset[segCount] = allStarts.length;

    this.segBounds = bounds;
    this.segOffset = segOffset;
    this.entryStart = Uint32Array.from(allStarts);
    this.entryRule = new Uint32Array(allRules.length);
    for (let i = 0; i < allRules.length; i++) {
      // -1 表示该端口区间无胜者，编码为 0xFFFFFFFF
      this.entryRule[i] = allRules[i] < 0 ? NO_RULE : allRules[i];
    }
    // 释放临时数组引用，便于 GC
    allStarts = [];
    allRules = [];
  }

  /** 返回获胜规则在 build 传入数组中的下标，无匹配返回 -1 */
  query(ip: number, port: number): number {
    const bounds = this.segBounds;
    if (bounds.length === 0 || ip < bounds[0]) return -1;
    // 找到 ip 所在网段：最后一个 <= ip 的边界；超出末段覆盖范围则无匹配
    const seg = upperBound(bounds, ip) - 1;
    if (seg < 0 || seg >= this.segOffset.length - 1) return -1;

    const from = this.segOffset[seg];
    const to = this.segOffset[seg + 1];
    if (from === to) return -1;

    // 在端口胜者表中找最后一个 start <= port 的条目
    const starts = this.entryStart;
    let lo = from;
    let hi = to; // [lo, hi)
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (starts[mid] <= port) lo = mid + 1;
      else hi = mid;
    }
    if (lo === from) return -1;
    const rule = this.entryRule[lo - 1];
    return rule === NO_RULE ? -1 : rule;
  }
}

/** 第一个 >= v 的下标 */
function lowerBound(a: number[], v: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 第一个 > v 的下标 */
function upperBound(a: ArrayLike<number>, v: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid] <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
