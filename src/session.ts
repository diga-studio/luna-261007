import { FEATURE_DIM, FEATURE_MAX, MAX_DISTANCE } from "./types.ts";
import type { FeatureVector, SessionConfig } from "./types.ts";

/**
 * number 累加器的安全上限：运行和保持小于 2^52 时，加上任意单项
 * （最大 10000 * 1040400 < 2^34）后仍小于 2^53，整数加法精确无舍入。
 */
const FLUSH_THRESHOLD = 2 ** 52;

function checkFeatures(features: FeatureVector, what: string): void {
  if (!Array.isArray(features) && !ArrayBuffer.isView(features)) {
    throw new TypeError(`${what}: features must be an array of ${FEATURE_DIM} integers`);
  }
  if (features.length !== FEATURE_DIM) {
    throw new TypeError(`${what}: features must have exactly ${FEATURE_DIM} dimensions`);
  }
  for (let d = 0; d < FEATURE_DIM; d++) {
    const v = features[d]!;
    if (!Number.isInteger(v) || v < 0 || v > FEATURE_MAX) {
      throw new TypeError(`${what}: features[${d}] must be an integer in [0, ${FEATURE_MAX}]`);
    }
  }
}

function checkSampleId(id: number, what: string): void {
  if (!Number.isSafeInteger(id) || id < 0) {
    throw new TypeError(`${what}: sample id must be a non-negative integer`);
  }
}

/**
 * 特征完全相同的一组候选样本。
 * 收益只取决于特征，因此同组样本在任意状态下收益始终相等；
 * 组内按 ID 升序依次被选中（收益相同时选 ID 较小者）。
 */
interface CandidateGroup {
  /** 组内样本下标，按样本 ID 升序。 */
  readonly members: number[];
  /** 组内最小 ID（members[0] 对应的 ID）。 */
  smallestId: number;
  /** 已被选走的成员数。 */
  taken: number;
}

/** 堆条目：某个候选组在某轮状态下的收益上界。 */
interface HeapEntry {
  /** 收益（精确整数，以 BigInt 保存）。 */
  gain: bigint;
  /** 所在候选组。 */
  group: CandidateGroup;
  /** 该收益是在完成了 tag 条选择之后计算的。 */
  tag: number;
}

/** 堆优先级：收益大者优先；收益相同则组内最小 ID 小者优先。 */
function higherPriority(a: HeapEntry, b: HeapEntry): boolean {
  if (a.gain !== b.gain) return a.gain > b.gain;
  return a.group.smallestId < b.group.smallestId;
}

/**
 * 多样性选样会话。
 *
 * 按贪心策略逐条产生推荐：每一步选取能使当前总覆盖代价下降最多的
 * 未标注候选，下降量相同时选 ID 较小者。推荐本身不改变标注状态。
 *
 * 实现上使用惰性贪心（CELF）：收益函数随已选集合增大而单调不增，
 * 堆中保存的是收益上界；弹出堆顶时若上界已按当前状态重算（新鲜），
 * 则它就是精确的贪心选择（含并列判定），否则重算后重新入堆。
 * 特征完全相同的候选合并为一组，避免大量相同收益导致的重复重算。
 */
export class DiversitySamplingSession {
  private readonly sampleCount: number;
  private readonly ids: number[];
  private readonly idToIndex: Map<number, number>;
  private readonly features: Uint8Array;
  private readonly repCount: number;
  private readonly repFeatures: Uint8Array;
  private readonly weights: Float64Array;
  /** 各代表点到已标注样本的最小距离（不含本批已选）。 */
  private readonly baseMin: Float64Array;
  private readonly labeled: Uint8Array;
  private labeledTotal: number;

  constructor(config: SessionConfig) {
    if (config === null || typeof config !== "object") {
      throw new TypeError("config must be an object");
    }
    const samples = config.samples;
    const representatives = config.representatives;
    if (!Array.isArray(samples)) {
      throw new TypeError("config.samples must be an array");
    }
    if (!Array.isArray(representatives)) {
      throw new TypeError("config.representatives must be an array");
    }

    this.sampleCount = samples.length;
    this.ids = new Array<number>(this.sampleCount);
    this.idToIndex = new Map<number, number>();
    this.features = new Uint8Array(this.sampleCount * FEATURE_DIM);
    this.labeled = new Uint8Array(this.sampleCount);

    for (let i = 0; i < this.sampleCount; i++) {
      const sample = samples[i]!;
      const what = `samples[${i}]`;
      if (sample === null || typeof sample !== "object") {
        throw new TypeError(`${what}: must be an object with id and features`);
      }
      checkSampleId(sample.id, what);
      if (this.idToIndex.has(sample.id)) {
        throw new TypeError(`${what}: duplicate sample id ${sample.id}`);
      }
      checkFeatures(sample.features, what);
      this.idToIndex.set(sample.id, i);
      this.ids[i] = sample.id;
      this.features.set(sample.features, i * FEATURE_DIM);
    }

    this.repCount = representatives.length;
    this.repFeatures = new Uint8Array(this.repCount * FEATURE_DIM);
    this.weights = new Float64Array(this.repCount);
    for (let r = 0; r < this.repCount; r++) {
      const rep = representatives[r]!;
      const what = `representatives[${r}]`;
      if (rep === null || typeof rep !== "object") {
        throw new TypeError(`${what}: must be an object with features and weight`);
      }
      checkFeatures(rep.features, what);
      if (!Number.isInteger(rep.weight) || rep.weight < 1 || rep.weight > 10_000) {
        throw new TypeError(`${what}: weight must be an integer in [1, 10000]`);
      }
      this.repFeatures.set(rep.features, r * FEATURE_DIM);
      this.weights[r] = rep.weight;
    }

    this.baseMin = new Float64Array(this.repCount).fill(MAX_DISTANCE);
    this.labeledTotal = 0;
    if (config.labeledIds !== undefined) {
      if (!Array.isArray(config.labeledIds)) {
        throw new TypeError("config.labeledIds must be an array of sample ids");
      }
      this.markLabeled(config.labeledIds);
    }
  }

  /** 把指定样本记为已标注；只有已标注样本才从后续候选中排除。 */
  markLabeled(ids: readonly number[]): void {
    if (!Array.isArray(ids)) {
      throw new TypeError("ids must be an array of sample ids");
    }
    for (const id of ids) {
      checkSampleId(id, "markLabeled");
      const index = this.idToIndex.get(id);
      if (index === undefined) {
        throw new TypeError(`markLabeled: unknown sample id ${id}`);
      }
      if (this.labeled[index] === 1) continue;
      this.labeled[index] = 1;
      this.labeledTotal++;
      this.coverWith(index, this.baseMin);
    }
  }

  /**
   * 请求下一批推荐（1 到 200 条），返回按产生顺序排列的样本 ID。
   * 不改变标注状态；未标注样本不足时返回全部剩余样本。
   */
  recommend(count: number): number[] {
    if (!Number.isInteger(count) || count < 1 || count > 200) {
      throw new RangeError("count must be an integer in [1, 200]");
    }
    const target = Math.min(count, this.sampleCount - this.labeledTotal);
    if (target === 0) return [];

    // 当前覆盖状态 = 已标注样本的覆盖；本批选择只作用于副本。
    const cur = new Float64Array(this.baseMin);

    // 特征完全相同的未标注候选合并为一组，组内按 ID 升序。
    const groups = this.buildGroups();

    // 惰性贪心堆：初始收益针对“已选 0 条”的状态计算。
    const heap: HeapEntry[] = groups.map((group) => ({
      gain: this.computeGain(group.members[0]!, cur),
      group,
      tag: 0,
    }));
    heapify(heap);

    const result: number[] = [];
    let selected = 0;
    while (result.length < target && heap.length > 0) {
      const top = heapPop(heap)!;
      if (top.tag === selected) {
        // 堆顶收益是按当前状态精确计算的：它就是贪心选择。
        const group = top.group;
        result.push(this.ids[group.members[group.taken]!]!);
        group.taken++;
        this.coverWith(group.members[0]!, cur);
        selected++;
        if (group.taken < group.members.length) {
          group.smallestId = this.ids[group.members[group.taken]!]!;
          // 收益上界仍然有效（收益只减不增），作为过期条目重新入堆。
          heapPush(heap, top);
        }
      } else {
        // 上界过期：按当前状态重算后重新入堆。
        top.gain = this.computeGain(top.group.members[0]!, cur);
        top.tag = selected;
        heapPush(heap, top);
      }
    }
    return result;
  }

  /** 当前已标注样本数。 */
  get labeledCount(): number {
    return this.labeledTotal;
  }

  /** 当前剩余未标注样本数。 */
  get remainingCount(): number {
    return this.sampleCount - this.labeledTotal;
  }

  /** 把未标注候选按特征分组，组内成员按样本 ID 升序排列。 */
  private buildGroups(): CandidateGroup[] {
    const byFeatures = new Map<string, number[]>();
    const keyBuffer = new Array<string>(FEATURE_DIM);
    for (let i = 0; i < this.sampleCount; i++) {
      if (this.labeled[i] === 1) continue;
      const offset = i * FEATURE_DIM;
      for (let d = 0; d < FEATURE_DIM; d++) {
        keyBuffer[d] = String.fromCharCode(this.features[offset + d]!);
      }
      const key = keyBuffer.join("");
      const bucket = byFeatures.get(key);
      if (bucket === undefined) {
        byFeatures.set(key, [i]);
      } else {
        bucket.push(i);
      }
    }
    const groups: CandidateGroup[] = [];
    for (const members of byFeatures.values()) {
      members.sort((a, b) => this.ids[a]! - this.ids[b]!);
      groups.push({
        members,
        smallestId: this.ids[members[0]!]!,
        taken: 0,
      });
    }
    return groups;
  }

  /** 用一条样本更新各代表点的最小距离。 */
  private coverWith(sampleIndex: number, cur: Float64Array): void {
    const sampleFeatures = this.features;
    const repFeatures = this.repFeatures;
    const so = sampleIndex * FEATURE_DIM;
    for (let r = 0; r < this.repCount; r++) {
      const ro = r * FEATURE_DIM;
      let dist = 0;
      for (let d = 0; d < FEATURE_DIM; d++) {
        const diff = sampleFeatures[so + d]! - repFeatures[ro + d]!;
        dist += diff * diff;
      }
      if (dist < cur[r]!) cur[r] = dist;
    }
  }

  /**
   * 精确计算候选样本的当前收益：
   * 各代表点 (当前最小距离 - 到该候选的距离，负值取 0) 乘以权重后求和。
   * 中间和用 number 累加并定期并入 BigInt，全程无舍入误差。
   */
  private computeGain(sampleIndex: number, cur: Float64Array): bigint {
    const sampleFeatures = this.features;
    const repFeatures = this.repFeatures;
    const weights = this.weights;
    const so = sampleIndex * FEATURE_DIM;
    let run = 0;
    let acc = 0n;
    for (let r = 0; r < this.repCount; r++) {
      const ro = r * FEATURE_DIM;
      let dist = 0;
      for (let d = 0; d < FEATURE_DIM; d++) {
        const diff = sampleFeatures[so + d]! - repFeatures[ro + d]!;
        dist += diff * diff;
      }
      const delta = cur[r]! - dist;
      if (delta > 0) {
        run += weights[r]! * delta;
        if (run >= FLUSH_THRESHOLD) {
          acc += BigInt(run);
          run = 0;
        }
      }
    }
    return acc + BigInt(run);
  }
}

function heapify(heap: HeapEntry[]): void {
  for (let i = (heap.length >> 1) - 1; i >= 0; i--) {
    siftDown(heap, i);
  }
}

function heapPush(heap: HeapEntry[], entry: HeapEntry): void {
  heap.push(entry);
  let i = heap.length - 1;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (!higherPriority(heap[i]!, heap[parent]!)) break;
    const tmp = heap[parent]!;
    heap[parent] = heap[i]!;
    heap[i] = tmp;
    i = parent;
  }
}

function heapPop(heap: HeapEntry[]): HeapEntry | undefined {
  const top = heap[0];
  if (top === undefined) return undefined;
  const last = heap.pop()!;
  if (heap.length > 0) {
    heap[0] = last;
    siftDown(heap, 0);
  }
  return top;
}

function siftDown(heap: HeapEntry[], start: number): void {
  let i = start;
  for (;;) {
    const left = 2 * i + 1;
    const right = left + 1;
    let best = i;
    if (left < heap.length && higherPriority(heap[left]!, heap[best]!)) best = left;
    if (right < heap.length && higherPriority(heap[right]!, heap[best]!)) best = right;
    if (best === i) return;
    const tmp = heap[best]!;
    heap[best] = heap[i]!;
    heap[i] = tmp;
    i = best;
  }
}

/** 建立选样会话。 */
export function createSession(config: SessionConfig): DiversitySamplingSession {
  return new DiversitySamplingSession(config);
}
