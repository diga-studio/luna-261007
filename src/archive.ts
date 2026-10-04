import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import type { MetricRecord } from './types.js';

const FORMAT_VERSION = 1;

interface ArchiveHeader {
  v: number;
  startHour: number;
  endHour: number;
  count: number;
}

interface ArchiveLine {
  r: string;
  h: number;
  rev: number;
  c: number;
}

function encode(records: MetricRecord[], startHour: number, endHour: number): Buffer {
  const header: ArchiveHeader = { v: FORMAT_VERSION, startHour, endHour, count: records.length };
  const lines = [JSON.stringify(header)];
  for (const rec of records) {
    const line: ArchiveLine = { r: rec.resource, h: rec.hour, rev: rec.revision, c: rec.cpu };
    lines.push(JSON.stringify(line));
  }
  return gzipSync(Buffer.from(lines.join('\n') + '\n', 'utf8'), { level: 9 });
}

function decode(buf: Buffer): { header: ArchiveHeader; records: MetricRecord[] } {
  const text = gunzipSync(buf).toString('utf8');
  const lines = text.split('\n').filter((l) => l.length > 0);
  if (lines.length === 0) throw new Error('archive: empty file');
  const header = JSON.parse(lines[0]!) as ArchiveHeader;
  if (header.v !== FORMAT_VERSION) throw new Error(`archive: bad version ${header.v}`);
  const records: MetricRecord[] = lines.slice(1).map((l) => {
    const line = JSON.parse(l) as ArchiveLine;
    return { resource: line.r, hour: line.h, revision: line.rev, cpu: line.c };
  });
  if (records.length !== header.count) {
    throw new Error(`archive: count mismatch ${records.length} != ${header.count}`);
  }
  return { header, records };
}

function fsyncDir(dir: string): void {
  const fd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Writes records to a gzip archive atomically: temp file in the same directory,
 * fsync, then rename. Returns the final file name (not a full path).
 */
export function writeArchiveFile(dir: string, startHour: number, endHour: number, records: MetricRecord[]): string {
  const name = `a${startHour}-${endHour}-${randomUUID()}.jsonl.gz`;
  const tmpName = `.${name}.tmp`;
  const tmpPath = path.join(dir, tmpName);
  const finalPath = path.join(dir, name);
  const data = encode(records, startHour, endHour);
  const fd = fs.openSync(tmpPath, 'w');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, finalPath);
  fsyncDir(dir);
  return name;
}

/** Reads a gzip archive back into its full metric content. */
export function readArchiveFile(filePath: string): MetricRecord[] {
  return decode(fs.readFileSync(filePath)).records;
}

/** Deletes a file if it exists; missing files are not an error (idempotent cleanup). */
export function removeFileIfExists(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
