import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { MetricInput } from './types.js';

const FILE_MAGIC = 'trimstack-cold-v1';
export const ARCHIVE_PREFIX = 'cold-';
export const ARCHIVE_SUFFIX = '.json.gz';

export interface ArchivePayload {
  magic: string;
  windowStart: number;
  records: MetricInput[];
}

/**
 * Atomically write a gzip-compressed archive of records into dir.
 * Every write produces a fresh unique file name; the caller is responsible
 * for retiring any superseded generation. Writes a temp file, fsyncs,
 * renames into place, then fsyncs the directory. Returns the file name.
 */
export function writeArchiveAtomic(dir: string, windowStart: number, records: MetricInput[]): string {
  const name = `${ARCHIVE_PREFIX}${windowStart}-${randomUUID()}${ARCHIVE_SUFFIX}`;
  const tmpName = `${name}.${process.pid}.tmp`;
  const tmpPath = path.join(dir, tmpName);
  const payload: ArchivePayload = { magic: FILE_MAGIC, windowStart, records };
  const data = gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'), { level: 9 });
  const fd = fs.openSync(tmpPath, 'w');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, path.join(dir, name));
  fsyncDir(dir);
  return name;
}

/** Read back the full record content of an archive file. */
export function readArchive(filePath: string): MetricInput[] {
  const raw = fs.readFileSync(filePath);
  const payload = JSON.parse(gunzipSync(raw).toString('utf8')) as ArchivePayload;
  if (payload.magic !== FILE_MAGIC || !Array.isArray(payload.records)) {
    throw new Error(`invalid archive file: ${filePath}`);
  }
  return payload.records;
}

/** List archive-looking file names present in dir (including stray temp files). */
export function listArchiveDir(dir: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return entries.filter((e) => e.startsWith(ARCHIVE_PREFIX));
}

/** Delete a file inside dir by name; missing files are ignored. */
export function deleteFile(dir: string, name: string): void {
  try {
    fs.unlinkSync(path.join(dir, name));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  fsyncDir(dir);
}

function fsyncDir(dir: string): void {
  const fd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
