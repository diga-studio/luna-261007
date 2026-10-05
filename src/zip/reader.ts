import { TextDecoder } from "node:util";
import type { RejectCode } from "../result.js";

export class ZipError extends Error {
  constructor(
    public readonly code: RejectCode,
    message: string,
  ) {
    super(message);
    this.name = "ZipError";
  }
}

export interface ZipEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
  localHeaderOffset: number;
  dataOffset: number;
  isDirectory: boolean;
}

export interface ZipArchive {
  entries: ZipEntry[];
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_DD = 0x08074b50;
const SIG_ZIP64_EOCD_LOCATOR = 0x07064b50;
const EXTRA_ZIP64 = 0x0001;

const FLAG_DATA_DESCRIPTOR = 0x08;
const FLAG_UTF8 = 0x800;
const FLAGS_ALLOWED = FLAG_DATA_DESCRIPTOR | FLAG_UTF8;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

const EOCD_MIN_LEN = 22;
const EOCD_MAX_COMMENT = 0xffff;
const CENTRAL_FIXED_LEN = 46;
const LOCAL_FIXED_LEN = 30;

function fail(code: RejectCode, message: string): never {
  throw new ZipError(code, message);
}

function decodeName(raw: Buffer, utf8: boolean): string {
  for (const b of raw) {
    if (b === 0) fail("ZIP_PATH_INVALID", "entry name contains NUL byte");
  }
  if (utf8) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      return fail("ZIP_PATH_INVALID", "entry name flagged UTF-8 is not valid UTF-8");
    }
  }
  for (const b of raw) {
    if (b < 0x20 || b > 0x7e) {
      fail("ZIP_PATH_INVALID", "non-ASCII entry name without UTF-8 flag");
    }
  }
  return raw.toString("latin1");
}

function scanExtraForZip64(extra: Buffer, context: string): void {
  let pos = 0;
  while (pos + 4 <= extra.length) {
    const id = extra.readUInt16LE(pos);
    const len = extra.readUInt16LE(pos + 2);
    if (pos + 4 + len > extra.length) {
      fail("ZIP_STRUCTURE_INVALID", `malformed extra field in ${context}`);
    }
    if (id === EXTRA_ZIP64) {
      fail("ZIP_UNSUPPORTED_FEATURE", `ZIP64 extra field in ${context}`);
    }
    pos += 4 + len;
  }
  if (pos !== extra.length) {
    fail("ZIP_STRUCTURE_INVALID", `trailing bytes in extra field of ${context}`);
  }
}

interface CentralRecord {
  name: string;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

function findEocd(data: Buffer): { offset: number; commentLength: number } {
  if (data.length < EOCD_MIN_LEN) {
    fail("NOT_ZIP", "file too small to be a ZIP archive");
  }
  const minOffset = Math.max(0, data.length - EOCD_MIN_LEN - EOCD_MAX_COMMENT);
  for (let pos = data.length - EOCD_MIN_LEN; pos >= minOffset; pos--) {
    if (data.readUInt32LE(pos) !== SIG_EOCD) continue;
    const commentLength = data.readUInt16LE(pos + 20);
    if (pos + EOCD_MIN_LEN + commentLength === data.length) {
      return { offset: pos, commentLength };
    }
  }
  fail("NOT_ZIP", "end of central directory record not found");
}

export function readZipArchive(data: Buffer): ZipArchive {
  const eocd = findEocd(data);
  const eocdOffset = eocd.offset;

  if (eocdOffset >= 20 && data.readUInt32LE(eocdOffset - 20) === SIG_ZIP64_EOCD_LOCATOR) {
    fail("ZIP_UNSUPPORTED_FEATURE", "ZIP64 archives are not supported");
  }

  const diskNumber = data.readUInt16LE(eocdOffset + 4);
  const cdStartDisk = data.readUInt16LE(eocdOffset + 6);
  const entriesThisDisk = data.readUInt16LE(eocdOffset + 8);
  const entriesTotal = data.readUInt16LE(eocdOffset + 10);
  const cdSize = data.readUInt32LE(eocdOffset + 12);
  const cdOffset = data.readUInt32LE(eocdOffset + 16);

  if (diskNumber !== 0 || cdStartDisk !== 0 || entriesThisDisk !== entriesTotal) {
    fail("ZIP_UNSUPPORTED_FEATURE", "multi-disk archives are not supported");
  }
  if (entriesTotal === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    fail("ZIP_UNSUPPORTED_FEATURE", "ZIP64 archives are not supported");
  }
  if (cdOffset + cdSize > eocdOffset) {
    fail("ZIP_STRUCTURE_INVALID", "central directory overlaps end record or is out of range");
  }

  const records: CentralRecord[] = [];
  const seenNames = new Set<string>();
  let pos = cdOffset;
  for (let i = 0; i < entriesTotal; i++) {
    if (pos + CENTRAL_FIXED_LEN > cdOffset + cdSize) {
      fail("ZIP_STRUCTURE_INVALID", "central directory truncated");
    }
    if (data.readUInt32LE(pos) !== SIG_CENTRAL) {
      fail("ZIP_STRUCTURE_INVALID", "bad central directory entry signature");
    }
    const versionNeeded = data.readUInt16LE(pos + 6);
    const flags = data.readUInt16LE(pos + 8);
    const method = data.readUInt16LE(pos + 10);
    const crc = data.readUInt32LE(pos + 16);
    const compressedSize = data.readUInt32LE(pos + 20);
    const uncompressedSize = data.readUInt32LE(pos + 24);
    const nameLen = data.readUInt16LE(pos + 28);
    const extraLen = data.readUInt16LE(pos + 30);
    const commentLen = data.readUInt16LE(pos + 32);
    const diskStart = data.readUInt16LE(pos + 34);
    const localHeaderOffset = data.readUInt32LE(pos + 42);
    const recordLen = CENTRAL_FIXED_LEN + nameLen + extraLen + commentLen;
    if (pos + recordLen > cdOffset + cdSize) {
      fail("ZIP_STRUCTURE_INVALID", "central directory entry overruns directory");
    }
    const rawName = data.subarray(pos + CENTRAL_FIXED_LEN, pos + CENTRAL_FIXED_LEN + nameLen);
    const extra = data.subarray(
      pos + CENTRAL_FIXED_LEN + nameLen,
      pos + CENTRAL_FIXED_LEN + nameLen + extraLen,
    );

    if (versionNeeded > 20) {
      fail("ZIP_UNSUPPORTED_FEATURE", `unsupported ZIP version needed: ${versionNeeded}`);
    }
    if (flags & ~FLAGS_ALLOWED) {
      fail("ZIP_UNSUPPORTED_FEATURE", `unsupported general purpose flags: 0x${flags.toString(16)}`);
    }
    if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
      fail("ZIP_UNSUPPORTED_FEATURE", `unsupported compression method: ${method}`);
    }
    if (diskStart !== 0) {
      fail("ZIP_UNSUPPORTED_FEATURE", "multi-disk archives are not supported");
    }
    if (
      crc === 0xffffffff ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      fail("ZIP_UNSUPPORTED_FEATURE", "ZIP64 archives are not supported");
    }
    scanExtraForZip64(extra, "central directory entry");

    const name = decodeName(rawName, (flags & FLAG_UTF8) !== 0);
    if (name.endsWith("/") && (crc !== 0 || compressedSize !== 0 || uncompressedSize !== 0)) {
      fail("ZIP_STRUCTURE_INVALID", `directory entry has non-zero sizes: ${name}`);
    }
    if (seenNames.has(name)) {
      fail("ZIP_STRUCTURE_INVALID", `duplicate entry name: ${name}`);
    }
    seenNames.add(name);

    records.push({
      name,
      flags,
      method,
      crc,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    pos += recordLen;
  }
  if (pos !== cdOffset + cdSize) {
    fail("ZIP_STRUCTURE_INVALID", "central directory size mismatch");
  }

  const entries: ZipEntry[] = [];
  const ranges: Array<{ start: number; end: number }> = [];
  for (const rec of records) {
    const entry = crossCheckLocalHeader(data, rec);
    entries.push(entry);
    ranges.push({ start: rec.localHeaderOffset, end: entryEnd(data, rec, entry) });
  }
  ranges.push({ start: cdOffset, end: cdOffset + cdSize });
  ranges.sort((a, b) => a.start - b.start);

  let cursor = 0;
  for (const range of ranges) {
    if (range.start !== cursor) {
      fail(
        "ZIP_STRUCTURE_INVALID",
        range.start < cursor
          ? "archive regions overlap"
          : "unexpected data between archive regions",
      );
    }
    cursor = range.end;
  }
  if (cursor !== eocdOffset) {
    fail("ZIP_STRUCTURE_INVALID", "unexpected data before end of central directory");
  }

  return { entries };
}

function crossCheckLocalHeader(data: Buffer, rec: CentralRecord): ZipEntry {
  const off = rec.localHeaderOffset;
  if (off + LOCAL_FIXED_LEN > data.length || data.readUInt32LE(off) !== SIG_LOCAL) {
    fail("ZIP_STRUCTURE_INVALID", `local header not found for entry ${rec.name}`);
  }
  const flags = data.readUInt16LE(off + 6);
  const method = data.readUInt16LE(off + 8);
  const crc = data.readUInt32LE(off + 14);
  const compressedSize = data.readUInt32LE(off + 18);
  const uncompressedSize = data.readUInt32LE(off + 22);
  const nameLen = data.readUInt16LE(off + 26);
  const extraLen = data.readUInt16LE(off + 28);
  const dataOffset = off + LOCAL_FIXED_LEN + nameLen + extraLen;
  if (dataOffset > data.length) {
    fail("ZIP_STRUCTURE_INVALID", `local header overruns file for entry ${rec.name}`);
  }
  const rawName = data.subarray(off + LOCAL_FIXED_LEN, off + LOCAL_FIXED_LEN + nameLen);
  const extra = data.subarray(off + LOCAL_FIXED_LEN + nameLen, dataOffset);

  if (flags !== rec.flags) {
    fail("ZIP_STRUCTURE_INVALID", `local/central flags mismatch for entry ${rec.name}`);
  }
  if (method !== rec.method) {
    fail("ZIP_STRUCTURE_INVALID", `local/central method mismatch for entry ${rec.name}`);
  }
  const localName = decodeName(rawName, (flags & FLAG_UTF8) !== 0);
  if (localName !== rec.name) {
    fail("ZIP_STRUCTURE_INVALID", `local/central name mismatch for entry ${rec.name}`);
  }
  scanExtraForZip64(extra, `local header of ${rec.name}`);

  const hasDescriptor = (rec.flags & FLAG_DATA_DESCRIPTOR) !== 0;
  if (hasDescriptor) {
    const localFieldsAreZero = crc === 0 && compressedSize === 0 && uncompressedSize === 0;
    const localFieldsMatch =
      crc === rec.crc &&
      compressedSize === rec.compressedSize &&
      uncompressedSize === rec.uncompressedSize;
    if (!localFieldsAreZero && !localFieldsMatch) {
      fail(
        "ZIP_STRUCTURE_INVALID",
        `local header CRC/sizes conflict with central directory for entry ${rec.name}`,
      );
    }
  } else if (
    crc !== rec.crc ||
    compressedSize !== rec.compressedSize ||
    uncompressedSize !== rec.uncompressedSize
  ) {
    fail(
      "ZIP_STRUCTURE_INVALID",
      `local header CRC/sizes differ from central directory for entry ${rec.name}`,
    );
  }

  return {
    name: rec.name,
    compressionMethod: rec.method,
    compressedSize: rec.compressedSize,
    uncompressedSize: rec.uncompressedSize,
    crc32: rec.crc,
    localHeaderOffset: off,
    dataOffset,
    isDirectory: rec.name.endsWith("/"),
  };
}

function entryEnd(data: Buffer, rec: CentralRecord, entry: ZipEntry): number {
  const dataEnd = entry.dataOffset + rec.compressedSize;
  if (dataEnd > data.length) {
    fail("ZIP_STRUCTURE_INVALID", `compressed data overruns file for entry ${rec.name}`);
  }
  if ((rec.flags & FLAG_DATA_DESCRIPTOR) === 0) {
    return dataEnd;
  }
  const tryParse = (withSignature: boolean): number | null => {
    if (withSignature) {
      if (dataEnd + 4 > data.length || data.readUInt32LE(dataEnd) !== SIG_DD) return null;
    }
    const base = withSignature ? dataEnd + 4 : dataEnd;
    if (base + 12 > data.length) return null;
    if (
      data.readUInt32LE(base) === rec.crc &&
      data.readUInt32LE(base + 4) === rec.compressedSize &&
      data.readUInt32LE(base + 8) === rec.uncompressedSize
    ) {
      return base + 12;
    }
    return null;
  };
  const end = tryParse(true) ?? tryParse(false);
  if (end === null) {
    fail(
      "ZIP_STRUCTURE_INVALID",
      `data descriptor values differ from central directory for entry ${rec.name}`,
    );
  }
  return end;
}
