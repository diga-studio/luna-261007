import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

/** Maximum accepted latency value in microseconds (inclusive). */
export const MAX_LATENCY_US = 10_000_000;

/**
 * Raw parsed records in columnar form, in file order. `deviceIndex[i]`
 * indexes into `deviceIds`; record i is
 * (deviceIds[deviceIndex[i]], timestampsMs[i], latenciesUs[i]).
 */
export interface ParsedMetrics {
  deviceIds: string[];
  deviceIndex: Uint32Array;
  timestampsMs: Float64Array;
  latenciesUs: Uint32Array;
}

function parseStrictInteger(text: string): number | null {
  if (!/^-?\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Splits from the right so device ids may contain commas:
 * `deviceId,timestampMs,latencyUs`.
 */
function parseLine(line: string): [deviceId: string, timestampMs: number, latencyUs: number] | null {
  const secondComma = line.lastIndexOf(',');
  if (secondComma <= 0) return null;
  const firstComma = line.lastIndexOf(',', secondComma - 1);
  if (firstComma <= 0) return null;
  const deviceId = line.slice(0, firstComma);
  const timestampMs = parseStrictInteger(line.slice(firstComma + 1, secondComma));
  const latencyUs = parseStrictInteger(line.slice(secondComma + 1));
  if (timestampMs === null || latencyUs === null) return null;
  return [deviceId, timestampMs, latencyUs];
}

/**
 * Parses a metrics file. Format: one CSV record per line
 * `deviceId,timestampMs,latencyUs`. Empty lines are skipped; a single
 * optional header line (one whose timestamp/latency fields are not
 * integers) is allowed as the first non-empty line. Any later malformed
 * line aborts the import with an error.
 */
export async function parseMetricsFile(filePath: string): Promise<ParsedMetrics> {
  const deviceIds: string[] = [];
  const deviceLookup = new Map<string, number>();
  const deviceIndex: number[] = [];
  const timestampsMs: number[] = [];
  const latenciesUs: number[] = [];

  let lineNo = 0;
  let firstRecordSeen = false;
  const stream = createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  });

  for await (const line of stream) {
    lineNo += 1;
    if (line.trim().length === 0) continue;
    const parsed = parseLine(line);
    if (parsed === null) {
      if (!firstRecordSeen) {
        // Tolerate a single header line such as "device,timestamp,latency".
        firstRecordSeen = true;
        continue;
      }
      throw new Error(`invalid metric record at line ${lineNo}: ${JSON.stringify(line)}`);
    }
    firstRecordSeen = true;
    const [deviceId, timestampMs, latencyUs] = parsed;
    if (latencyUs < 0 || latencyUs > MAX_LATENCY_US) {
      throw new Error(
        `latency out of range [0, ${MAX_LATENCY_US}] at line ${lineNo}: ${latencyUs}`,
      );
    }
    let index = deviceLookup.get(deviceId);
    if (index === undefined) {
      index = deviceIds.length;
      deviceLookup.set(deviceId, index);
      deviceIds.push(deviceId);
    }
    deviceIndex.push(index);
    timestampsMs.push(timestampMs);
    latenciesUs.push(latencyUs);
  }

  return {
    deviceIds,
    deviceIndex: Uint32Array.from(deviceIndex),
    timestampsMs: Float64Array.from(timestampsMs),
    latenciesUs: Uint32Array.from(latenciesUs),
  };
}
