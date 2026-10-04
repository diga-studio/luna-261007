import type { ParsedMetrics } from './parser.ts';
import { MAX_LATENCY_US } from './parser.ts';
import type { Dataset, QueryOptions, QueryStats } from './types.ts';
import { parseMetricsFile } from './parser.ts';
import { WaveletMatrix } from './waveletMatrix.ts';

/** Bit levels needed to represent every latency in [0, MAX_LATENCY_US]. */
const LATENCY_LEVELS = 24; // 2^23 < 10_000_000 < 2^24

if (2 ** LATENCY_LEVELS <= MAX_LATENCY_US) {
  throw new Error('LATENCY_LEVELS does not cover MAX_LATENCY_US');
}

/** First index in [lo, hi) whose value is >= target. */
function lowerBound(values: Float64Array, lo: number, hi: number, target: number): number {
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Position (1-based) of the exact quantile p in N ordered values. */
function quantilePosition(count: number, numerator: number, denominator: number): number {
  return Math.ceil((count * numerator) / denominator);
}

class LatencyDataset implements Dataset {
  readonly deviceIds: readonly string[];
  readonly recordCount: number;

  private readonly deviceLookup: Map<string, number>;
  /** deviceOffsets[d]..deviceOffsets[d+1] is device d's slice of the sorted arrays. */
  private readonly deviceOffsets: Uint32Array;
  /** Timestamps sorted by (device, timestamp). */
  private readonly timestampsMs: Float64Array;
  private readonly matrix: WaveletMatrix;

  constructor(parsed: ParsedMetrics) {
    const n = parsed.timestampsMs.length;
    const deviceCount = parsed.deviceIds.length;
    this.recordCount = n;
    this.deviceIds = parsed.deviceIds;
    this.deviceLookup = new Map(parsed.deviceIds.map((id, index) => [id, index]));

    const counts = new Uint32Array(deviceCount + 1);
    for (let i = 0; i < n; i++) counts[parsed.deviceIndex[i]! + 1]! += 1;
    for (let d = 0; d < deviceCount; d++) counts[d + 1]! += counts[d]!;
    this.deviceOffsets = counts;

    // Sort record indices by (device, timestamp); ties keep every record.
    const order: number[] = new Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    const deviceIndex = parsed.deviceIndex;
    const timestamps = parsed.timestampsMs;
    order.sort((a, b) => {
      const deviceDiff = deviceIndex[a]! - deviceIndex[b]!;
      if (deviceDiff !== 0) return deviceDiff;
      return timestamps[a]! - timestamps[b]!;
    });

    const sortedTimestamps = new Float64Array(n);
    const sortedLatencies = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      const source = order[i]!;
      sortedTimestamps[i] = timestamps[source]!;
      sortedLatencies[i] = parsed.latenciesUs[source]!;
    }
    this.timestampsMs = sortedTimestamps;
    this.matrix = new WaveletMatrix(sortedLatencies, LATENCY_LEVELS);
  }

  query(options: QueryOptions): QueryStats {
    const { startMs, endMs, deviceId } = options;
    if (!Number.isInteger(startMs) || !Number.isInteger(endMs)) {
      throw new TypeError('startMs and endMs must be integers');
    }
    if (startMs >= endMs) {
      throw new RangeError('startMs must be earlier than endMs');
    }

    let deviceIndices: number[];
    if (deviceId === undefined) {
      deviceIndices = new Array(this.deviceIds.length);
      for (let d = 0; d < deviceIndices.length; d++) deviceIndices[d] = d;
    } else {
      const index = this.deviceLookup.get(deviceId);
      if (index === undefined) {
        throw new Error(`unknown device: ${JSON.stringify(deviceId)}`);
      }
      deviceIndices = [index];
    }

    const ranges = new Uint32Array(2 * deviceIndices.length);
    let rangeCount = 0;
    let count = 0;
    for (const d of deviceIndices) {
      const lo = this.deviceOffsets[d]!;
      const hi = this.deviceOffsets[d + 1]!;
      const left = lowerBound(this.timestampsMs, lo, hi, startMs);
      const right = lowerBound(this.timestampsMs, lo, hi, endMs);
      if (left < right) {
        ranges[2 * rangeCount] = left;
        ranges[2 * rangeCount + 1] = right;
        rangeCount += 1;
        count += right - left;
      }
    }

    if (count === 0) {
      return { count: 0, throughputPerSec: 0, p50: null, p95: null, p99: null };
    }

    const seconds = (endMs - startMs) / 1000;
    return {
      count,
      throughputPerSec: count / seconds,
      p50: this.matrix.kthInRanges(ranges, rangeCount, quantilePosition(count, 50, 100) - 1),
      p95: this.matrix.kthInRanges(ranges, rangeCount, quantilePosition(count, 95, 100) - 1),
      p99: this.matrix.kthInRanges(ranges, rangeCount, quantilePosition(count, 99, 100) - 1),
    };
  }
}

/** Builds a read-only dataset from parsed metrics. */
export function buildDataset(parsed: ParsedMetrics): Dataset {
  return new LatencyDataset(parsed);
}

/** Imports a metrics file into a read-only dataset. */
export async function importMetrics(filePath: string): Promise<Dataset> {
  const parsed = await parseMetricsFile(filePath);
  return buildDataset(parsed);
}

export type { Dataset, QueryOptions, QueryStats };
