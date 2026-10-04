import {
  EMPTY_COVER_COST,
  FEATURE_DIM,
  FEATURE_MAX,
  FEATURE_MIN,
  MAX_BATCH,
  WEIGHT_MAX,
  WEIGHT_MIN,
} from "./types";
import type { SessionConfig } from "./types";
import { GainHeap } from "./heap";

function isInt(value: number): boolean {
  return typeof value === "number" && Number.isInteger(value);
}

function readFeatures(features: ArrayLike<number>, into: Uint8Array, offset: number, what: string): void {
  if (features == null || features.length !== FEATURE_DIM) {
    throw new Error(`${what}: features must have length ${FEATURE_DIM}`);
  }
  for (let d = 0; d < FEATURE_DIM; d++) {
    const v = features[d];
    if (!isInt(v) || v < FEATURE_MIN || v > FEATURE_MAX) {
      throw new Error(`${what}: features[${d}] must be an integer in [${FEATURE_MIN}, ${FEATURE_MAX}]`);
    }
    into[offset + d] = v;
  }
}

/** squared L2 distance between sample at so and representative at ro */
function distSq(samples: Uint8Array, so: number, reps: Uint8Array, ro: number): number {
  let s = 0;
  for (let d = 0; d < FEATURE_DIM; d++) {
    const diff = samples[so + d] - reps[ro + d];
    s += diff * diff;
  }
  return s;
}

export class DiversitySession {
  private readonly count: number;
  private readonly repCount: number;
  /** sample ids sorted ascending */
  private readonly ids: Uint32Array;
  private readonly indexById: Map<number, number>;
  /** count * FEATURE_DIM */
  private readonly sampleFeatures: Uint8Array;
  /** repCount * FEATURE_DIM */
  private readonly repFeatures: Uint8Array;
  private readonly repWeights: Float64Array;
  /** 1 = labeled */
  private readonly labeled: Uint8Array;
  private labeledTotal = 0;
  /** current min squared distance from each representative to labeled samples */
  private readonly cover: Float64Array;

  constructor(config: SessionConfig) {
    if (config == null) throw new Error("config is required");
    const samples = config.samples;
    const representatives = config.representatives;
    if (!Array.isArray(samples)) throw new Error("config.samples must be an array");
    if (!Array.isArray(representatives)) throw new Error("config.representatives must be an array");

    this.count = samples.length;
    this.repCount = representatives.length;
    this.ids = new Uint32Array(this.count);
    this.indexById = new Map<number, number>();
    this.sampleFeatures = new Uint8Array(this.count * FEATURE_DIM);
    this.repFeatures = new Uint8Array(this.repCount * FEATURE_DIM);
    this.repWeights = new Float64Array(this.repCount);
    this.labeled = new Uint8Array(this.count);
    this.cover = new Float64Array(this.repCount);

    const order: number[] = new Array(this.count);
    for (let i = 0; i < this.count; i++) {
      const s = samples[i];
      if (s == null || !isInt(s.id) || s.id < 0) {
        throw new Error(`samples[${i}]: id must be a non-negative integer`);
      }
      if (this.indexById.has(s.id)) {
        throw new Error(`samples[${i}]: duplicate id ${s.id}`);
      }
      this.indexById.set(s.id, i);
      order[i] = s.id;
    }
    // store samples sorted by id so tie-breaking by smaller id is natural
    order.sort((a, b) => a - b);
    const sortedFeatures = this.sampleFeatures;
    for (let pos = 0; pos < this.count; pos++) {
      const id = order[pos];
      const src = this.indexById.get(id)!;
      this.ids[pos] = id;
      readFeatures(samples[src].features, sortedFeatures, pos * FEATURE_DIM, `samples[${src}] (id ${id})`);
    }
    this.indexById.clear();
    for (let pos = 0; pos < this.count; pos++) this.indexById.set(this.ids[pos], pos);

    for (let j = 0; j < this.repCount; j++) {
      const r = representatives[j];
      if (r == null || !isInt(r.weight) || r.weight < WEIGHT_MIN || r.weight > WEIGHT_MAX) {
        throw new Error(`representatives[${j}]: weight must be an integer in [${WEIGHT_MIN}, ${WEIGHT_MAX}]`);
      }
      readFeatures(r.features, this.repFeatures, j * FEATURE_DIM, `representatives[${j}]`);
      this.repWeights[j] = r.weight;
      this.cover[j] = EMPTY_COVER_COST;
    }

    if (config.labeledIds != null) {
      this.markLabeled(config.labeledIds);
    }
  }

  /** Mark samples as labeled. Idempotent for already-labeled ids. */
  markLabeled(ids: Iterable<number>): void {
    if (ids == null || typeof (ids as any)[Symbol.iterator] !== "function") {
      throw new Error("markLabeled: ids must be iterable");
    }
    for (const id of ids) {
      if (!isInt(id) || id < 0) {
        throw new Error(`markLabeled: id ${id} must be a non-negative integer`);
      }
      const pos = this.indexById.get(id);
      if (pos === undefined) {
        throw new Error(`markLabeled: unknown sample id ${id}`);
      }
      if (this.labeled[pos] === 1) continue;
      this.labeled[pos] = 1;
      this.labeledTotal++;
      this.updateCoverWith(pos);
    }
  }

  private updateCoverWith(pos: number): void {
    this.applyToCover(this.cover, pos);
  }

  private applyToCover(cover: Float64Array, pos: number): void {
    const so = pos * FEATURE_DIM;
    for (let j = 0; j < this.repCount; j++) {
      const cur = cover[j];
      if (cur === 0) continue;
      const d = distSq(this.sampleFeatures, so, this.repFeatures, j * FEATURE_DIM);
      if (d < cur) cover[j] = d;
    }
  }

  /** weighted coverage gain of candidate pos against the given cover state */
  private computeGain(pos: number, cover: Float64Array): number {
    const so = pos * FEATURE_DIM;
    const weights = this.repWeights;
    let gain = 0;
    for (let j = 0; j < this.repCount; j++) {
      const cur = cover[j];
      if (cur === 0) continue;
      const d = distSq(this.sampleFeatures, so, this.repFeatures, j * FEATURE_DIM);
      if (d < cur) gain += weights[j] * (cur - d);
    }
    return gain;
  }

  /**
   * Greedy max-coverage-gain batch recommendation.
   * Does not mutate labeling state; pure function of the current state.
   * Uses lazy greedy (CELF): gains are monotone non-increasing as coverage
   * improves, so stored gains are exact upper bounds and the lazy order
   * yields exactly the same sequence as recomputing every candidate each step.
   */
  recommend(count: number): number[] {
    if (!isInt(count) || count < 1 || count > MAX_BATCH) {
      throw new Error(`recommend: count must be an integer in [1, ${MAX_BATCH}]`);
    }
    const take = Math.min(count, this.count - this.labeledTotal);
    if (take <= 0) return [];

    // working copy of the cover state; the session state stays untouched
    const work = Float64Array.from(this.cover);

    const heap = new GainHeap(this.count - this.labeledTotal, this.ids);
    for (let pos = 0; pos < this.count; pos++) {
      if (this.labeled[pos] === 0) heap.push(pos, this.computeGain(pos, work));
    }

    const result: number[] = [];
    while (result.length < take) {
      const pos = heap.peekPos();
      heap.pop();
      const gain = this.computeGain(pos, work);
      if (heap.length === 0) {
        this.applyToCover(work, pos);
        result.push(this.ids[pos]);
        break;
      }
      const topPos = heap.peekPos();
      const topGain = heap.peekGain();
      // selectable iff (gain, id) >= (topGain, topId) in the heap order;
      // stored gains are upper bounds on the true current gains
      if (gain > topGain || (gain === topGain && this.ids[pos] < this.ids[topPos])) {
        this.applyToCover(work, pos);
        result.push(this.ids[pos]);
      } else {
        heap.push(pos, gain);
      }
    }
    return result;
  }

  get labeledCount(): number {
    return this.labeledTotal;
  }

  get poolSize(): number {
    return this.count;
  }
}
