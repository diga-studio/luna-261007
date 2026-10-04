import { readFileSync } from 'node:fs';
import { MergeSortTree } from './mergeSortTree.js';
import type { Dataset, QueryOptions, QueryStats } from './types.js';

const MAX_LATENCY_US = 10_000_000;
const PERCENTILE_RANKS: ReadonlyArray<readonly [keyof Pick<QueryStats, 'p50' | 'p95' | 'p99'>, number]> = [
  ['p50', 0.5],
  ['p95', 0.95],
  ['p99', 0.99],
];

const COMMA = 44;
const NEWLINE = 10;
const CARRIAGE_RETURN = 13;
const SPACE = 32;
const TAB = 9;

/**
 * Import metrics from a local file and build an immutable queryable dataset.
 *
 * File format: one record per line, CSV without header:
 *   deviceId,timestampMs,latencyUs
 * - deviceId: non-empty string without commas
 * - timestampMs: integer milliseconds
 * - latencyUs: integer microseconds in [0, 10000000]
 * Lines may appear in any order; timestamps may repeat; identical lines
 * still count as distinct inferences. Blank lines are ignored.
 */
export function importMetricsFromFile(path: string): Dataset {
  const content = readFileSync(path, 'utf8');

  // First pass: count records. Second pass: fill typed arrays. Scanning by
  // char code avoids materializing millions of line/word strings, which
  // keeps peak memory low on multi-million-record files.
  let recordCount = 0;
  {
    let pos = 0;
    while (pos < content.length) {
      pos = skipWhitespace(content, pos);
      if (pos >= content.length) break;
      const end = content.indexOf('\n', pos);
      pos = end === -1 ? content.length : end + 1;
      recordCount++;
    }
  }

  const deviceIndexById = new Map<string, number>();
  const deviceIds: string[] = [];
  const timestamps = new Float64Array(recordCount);
  const latencies = new Uint32Array(recordCount);
  const deviceIndices = new Uint32Array(recordCount);

  let i = 0;
  let pos = 0;
  let lineNo = 0;
  while (pos < content.length) {
    lineNo++;
    pos = skipWhitespace(content, pos);
    if (pos >= content.length) break;
    let end = content.indexOf('\n', pos);
    if (end === -1) end = content.length;
    let lineEnd = end;
    while (lineEnd > pos && isInlineWhitespace(content.charCodeAt(lineEnd - 1))) lineEnd--;
    const nextPos = end + 1;

    const firstComma = content.indexOf(',', pos);
    const lastComma = content.lastIndexOf(',', lineEnd);
    if (firstComma === -1 || firstComma >= lineEnd || firstComma === lastComma || firstComma === pos) {
      throw new Error(`Invalid metric line ${lineNo}: ${JSON.stringify(content.slice(pos, lineEnd))}`);
    }
    const deviceId = content.slice(pos, firstComma);
    const timestampMs = parseInteger(content, firstComma + 1, lastComma);
    const latencyUs = parseInteger(content, lastComma + 1, lineEnd);
    if (timestampMs === null) {
      throw new Error(`Invalid timestamp on line ${lineNo}: must be integer milliseconds`);
    }
    if (latencyUs === null || latencyUs < 0 || latencyUs > MAX_LATENCY_US) {
      throw new Error(`Invalid latency on line ${lineNo}: must be integer microseconds in [0, ${MAX_LATENCY_US}]`);
    }

    let deviceIndex = deviceIndexById.get(deviceId);
    if (deviceIndex === undefined) {
      deviceIndex = deviceIds.length;
      deviceIndexById.set(deviceId, deviceIndex);
      deviceIds.push(deviceId);
    }
    deviceIndices[i] = deviceIndex;
    timestamps[i] = timestampMs;
    latencies[i] = latencyUs;
    i++;
    pos = nextPos;
  }

  return buildDataset(deviceIds, deviceIndexById, timestamps, latencies, deviceIndices, recordCount);
}

function isInlineWhitespace(code: number): boolean {
  return code === SPACE || code === TAB || code === CARRIAGE_RETURN;
}

function skipWhitespace(content: string, pos: number): number {
  while (pos < content.length) {
    const code = content.charCodeAt(pos);
    if (code === NEWLINE || isInlineWhitespace(code)) {
      pos++;
    } else {
      break;
    }
  }
  return pos;
}

/** Parse an optionally-signed integer exactly, or return null. */
function parseInteger(content: string, start: number, end: number): number | null {
  while (start < end && isInlineWhitespace(content.charCodeAt(start))) start++;
  while (end > start && isInlineWhitespace(content.charCodeAt(end - 1))) end--;
  if (start >= end) return null;
  let pos = start;
  let negative = false;
  if (content.charCodeAt(pos) === 45) {
    negative = true;
    pos++;
  }
  if (pos >= end) return null;
  let value = 0;
  for (; pos < end; pos++) {
    const digit = content.charCodeAt(pos) - 48;
    if (digit < 0 || digit > 9) return null;
    value = value * 10 + digit;
    if (value > Number.MAX_SAFE_INTEGER) return null;
  }
  return negative ? -value : value;
}

function buildDataset(
  deviceIds: string[],
  deviceIndexById: Map<string, number>,
  timestamps: Float64Array,
  latencies: Uint32Array,
  deviceIndices: Uint32Array,
  recordCount: number,
): Dataset {
  // Order all records by timestamp (equal timestamps are interchangeable
  // because every record is counted individually).
  const order = new Uint32Array(recordCount);
  for (let i = 0; i < recordCount; i++) order[i] = i;
  order.sort((a, b) => timestamps[a] - timestamps[b]);

  const sortedTimestamps = new Float64Array(recordCount);
  const latenciesInTimeOrder = new Uint32Array(recordCount);
  for (let i = 0; i < recordCount; i++) {
    sortedTimestamps[i] = timestamps[order[i]];
    latenciesInTimeOrder[i] = latencies[order[i]];
  }

  // Per-device arrays, each sorted by timestamp (built in time order).
  const deviceCount = deviceIds.length;
  const perDeviceCounts = new Uint32Array(deviceCount);
  for (let i = 0; i < recordCount; i++) perDeviceCounts[deviceIndices[i]]++;
  const perDeviceTimestamps = new Array<Float64Array>(deviceCount);
  const perDeviceLatencies = new Array<Uint32Array>(deviceCount);
  const perDeviceCursor = new Uint32Array(deviceCount);
  for (let d = 0; d < deviceCount; d++) {
    perDeviceTimestamps[d] = new Float64Array(perDeviceCounts[d]);
    perDeviceLatencies[d] = new Uint32Array(perDeviceCounts[d]);
  }
  for (let i = 0; i < recordCount; i++) {
    const d = deviceIndices[order[i]];
    const c = perDeviceCursor[d]++;
    perDeviceTimestamps[d][c] = sortedTimestamps[i];
    perDeviceLatencies[d][c] = latenciesInTimeOrder[i];
  }

  const tree = new MergeSortTree(latenciesInTimeOrder, MAX_LATENCY_US);

  const emptyStats: QueryStats = { count: 0, throughputPerSec: 0, p50: null, p95: null, p99: null };

  function query(options: QueryOptions): QueryStats {
    const { startMs, endMs, deviceId } = options;
    if (!Number.isInteger(startMs) || !Number.isInteger(endMs)) {
      throw new RangeError('Query bounds must be integer milliseconds');
    }
    if (startMs >= endMs) {
      throw new RangeError(`Query start (${startMs}) must be earlier than end (${endMs})`);
    }
    const rangeSeconds = (endMs - startMs) / 1000;

    if (deviceId !== undefined) {
      const deviceIndex = deviceIndexById.get(deviceId);
      if (deviceIndex === undefined) return emptyStats;
      const ts = perDeviceTimestamps[deviceIndex];
      const from = lowerBound(ts, startMs);
      const to = lowerBound(ts, endMs);
      const count = to - from;
      if (count === 0) return emptyStats;
      const slice = perDeviceLatencies[deviceIndex].slice(from, to);
      slice.sort();
      const stats: Record<string, number | null> = {};
      for (const [key, p] of PERCENTILE_RANKS) {
        stats[key] = slice[Math.ceil(count * p) - 1];
      }
      return {
        count,
        throughputPerSec: count / rangeSeconds,
        p50: stats['p50'],
        p95: stats['p95'],
        p99: stats['p99'],
      } as QueryStats;
    }

    const from = lowerBound(sortedTimestamps, startMs);
    const to = lowerBound(sortedTimestamps, endMs);
    const count = to - from;
    if (count === 0) return emptyStats;
    const stats: Record<string, number | null> = {};
    for (const [key, p] of PERCENTILE_RANKS) {
      stats[key] = tree.kthSmallest(from, to, Math.ceil(count * p));
    }
    return {
      count,
      throughputPerSec: count / rangeSeconds,
      p50: stats['p50'],
      p95: stats['p95'],
      p99: stats['p99'],
    } as QueryStats;
  }

  return {
    recordCount,
    deviceIds: Object.freeze(deviceIds.slice()),
    query,
  };
}

/** First index whose value is >= target. */
function lowerBound(data: Float64Array, target: number): number {
  let lo = 0;
  let hi = data.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (data[mid] < target) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

export type { Dataset, QueryOptions, QueryStats };
