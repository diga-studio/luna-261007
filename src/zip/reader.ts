import { inflateRawSync } from "node:zlib";
import { crc32 } from "../crc32.ts";
import type { ZipArchive, ZipEntry } from "./types.ts";

export class ZipError extends Error {
  readonly code:
    | "NOT_ZIP"
    | "ZIP_UNSUPPORTED_FEATURE"
    | "ZIP_STRUCTURE_INVALID"
    | "ZIP_ENTRY_MISMATCH"
    | "ZIP_ENTRY_CRC_MISMATCH"
    | "ZIP_ENTRY_SIZE_MISMATCH"
    | "ZIP_ENTRY_OVERLAP"
    | "ZIP_NAME_INVALID";

  constructor(code: ZipError["code"], message: string) {
    super(message);
    this.name = "ZipError";
    this.code = code;
  }
}

const EOCD_SIG = 0x06054b50;
const EOCD_MIN_LEN = 22;
const EOCD_MAX_COMMENT = 0xffff;
const CD_ENTRY_SIG = 0x02014b50;
const CD_ENTRY_LEN = 46;
const LOCAL_SIG = 0x04034b50;
const LOCAL_LEN = 30;
const DD_SIG = 0x08074b50;

const FLAG_ENCRYPTED = 0x0001;
const FLAG_DATA_DESCRIPTOR = 0x0008;
const FLAG_STRONG_ENCRYPTED = 0x0040;
const FLAG_UTF8 = 0x0800;
const FLAG_CD_ENCRYPTED = 0x2000;
const UNSUPPORTED_FLAGS =
  FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTED | FLAG_CD_ENCRYPTED;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

const EXTRA_ZIP64 = 0x0001;

interface CentralEntry {
  nameBytes: Uint8Array;
  name: string;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

function u16(buf: Uint8Array, off: number): number {
  return buf[off]! | (buf[off + 1]! << 8);
}

function u32(buf: Uint8Array, off: number): number {
  return (
    (buf[off]! |
      (buf[off + 1]! << 8) |
      (buf[off + 2]! << 16) |
      (buf[off + 3]! << 24)) >>>
    0
  );
}

function fail(code: ZipError["code"], message: string): never {
  throw new ZipError(code, message);
}

function hasZip64Extra(extra: Uint8Array): boolean {
  let off = 0;
  while (off + 4 <= extra.length) {
    const id = u16(extra, off);
    const len = u16(extra, off + 2);
    if (off + 4 + len > extra.length) break;
    if (id === EXTRA_ZIP64) return true;
    off += 4 + len;
  }
  return false;
}

function decodeName(nameBytes: Uint8Array, utf8: boolean): string {
  if (utf8) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(nameBytes);
    } catch {
      fail("ZIP_NAME_INVALID", "条目名称不是有效的 UTF-8");
    }
  }
  for (const b of nameBytes) {
    if (b > 0x7f) {
      fail(
        "ZIP_NAME_INVALID",
        "条目名称含非 ASCII 字节但未声明 UTF-8 标志",
      );
    }
  }
  return new TextDecoder("ascii").decode(nameBytes);
}

function findEocd(buf: Uint8Array): number {
  const min = Math.max(0, buf.length - EOCD_MIN_LEN - EOCD_MAX_COMMENT);
  for (let off = buf.length - EOCD_MIN_LEN; off >= min; off--) {
    if (u32(buf, off) !== EOCD_SIG) continue;
    const commentLen = u16(buf, off + 20);
    if (off + EOCD_MIN_LEN + commentLen === buf.length) return off;
  }
  fail("NOT_ZIP", "未找到 ZIP 结束记录（EOCD）");
}

function parseCentralDirectory(
  buf: Uint8Array,
  cdOffset: number,
  cdSize: number,
  count: number,
): CentralEntry[] {
  const entries: CentralEntry[] = [];
  let off = cdOffset;
  for (let i = 0; i < count; i++) {
    if (off + CD_ENTRY_LEN > buf.length || u32(buf, off) !== CD_ENTRY_SIG) {
      fail("ZIP_STRUCTURE_INVALID", "中央目录条目损坏或数量不符");
    }
    const flags = u16(buf, off + 8);
    const method = u16(buf, off + 10);
    const crc = u32(buf, off + 16);
    const compressedSize = u32(buf, off + 20);
    const uncompressedSize = u32(buf, off + 24);
    const nameLen = u16(buf, off + 28);
    const extraLen = u16(buf, off + 30);
    const commentLen = u16(buf, off + 32);
    const diskStart = u16(buf, off + 34);
    const localHeaderOffset = u32(buf, off + 42);
    const fixed =
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff ||
      diskStart === 0xffff;
    if (fixed) {
      fail("ZIP_UNSUPPORTED_FEATURE", "不支持 ZIP64 归档");
    }
    if (diskStart !== 0) {
      fail("ZIP_UNSUPPORTED_FEATURE", "不支持分卷归档");
    }
    if (flags & UNSUPPORTED_FLAGS) {
      fail("ZIP_UNSUPPORTED_FEATURE", "不支持加密的 ZIP 条目");
    }
    if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
      fail("ZIP_UNSUPPORTED_FEATURE", `不支持的压缩方式: ${method}`);
    }
    const nameStart = off + CD_ENTRY_LEN;
    const extraStart = nameStart + nameLen;
    const end = extraStart + extraLen + commentLen;
    if (end > buf.length) {
      fail("ZIP_STRUCTURE_INVALID", "中央目录条目越界");
    }
    const nameBytes = buf.subarray(nameStart, extraStart);
    const extra = buf.subarray(extraStart, extraStart + extraLen);
    if (hasZip64Extra(extra)) {
      fail("ZIP_UNSUPPORTED_FEATURE", "不支持 ZIP64 扩展字段");
    }
    entries.push({
      nameBytes,
      name: decodeName(nameBytes, (flags & FLAG_UTF8) !== 0),
      flags,
      method,
      crc,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    off = end;
  }
  if (off !== cdOffset + cdSize) {
    fail("ZIP_STRUCTURE_INVALID", "中央目录大小与记录不符");
  }
  return entries;
}

interface ParsedLocal {
  dataStart: number;
  dataEnd: number;
  descriptorEnd: number;
}

function parseLocalAndData(
  buf: Uint8Array,
  entry: CentralEntry,
  rangeEnd: number,
): ParsedLocal {
  const off = entry.localHeaderOffset;
  if (off + LOCAL_LEN > buf.length || u32(buf, off) !== LOCAL_SIG) {
    fail("ZIP_ENTRY_MISMATCH", `条目 ${entry.name} 的本地头缺失或损坏`);
  }
  const flags = u16(buf, off + 6);
  const method = u16(buf, off + 8);
  const localCrc = u32(buf, off + 14);
  const localComp = u32(buf, off + 18);
  const localUncomp = u32(buf, off + 22);
  const nameLen = u16(buf, off + 26);
  const extraLen = u16(buf, off + 28);
  const dataStart = off + LOCAL_LEN + nameLen + extraLen;
  if (dataStart > buf.length) {
    fail("ZIP_STRUCTURE_INVALID", "本地头越界");
  }
  const localName = buf.subarray(off + LOCAL_LEN, off + LOCAL_LEN + nameLen);
  if (
    localName.length !== entry.nameBytes.length ||
    !localName.every((b, i) => b === entry.nameBytes[i])
  ) {
    fail(
      "ZIP_ENTRY_MISMATCH",
      `条目 ${entry.name} 的本地头名称与中央目录不一致`,
    );
  }
  if (flags !== entry.flags || method !== entry.method) {
    fail(
      "ZIP_ENTRY_MISMATCH",
      `条目 ${entry.name} 的本地头标志/压缩方式与中央目录不一致`,
    );
  }
  const extra = buf.subarray(off + LOCAL_LEN + nameLen, dataStart);
  if (hasZip64Extra(extra)) {
    fail("ZIP_UNSUPPORTED_FEATURE", "不支持 ZIP64 扩展字段");
  }
  const hasDescriptor = (flags & FLAG_DATA_DESCRIPTOR) !== 0;
  if (!hasDescriptor) {
    if (
      localCrc !== entry.crc ||
      localComp !== entry.compressedSize ||
      localUncomp !== entry.uncompressedSize
    ) {
      fail(
        "ZIP_ENTRY_MISMATCH",
        `条目 ${entry.name} 的本地头 CRC/长度与中央目录不一致`,
      );
    }
  } else {
    const zeroFilled = localCrc === 0 && localComp === 0 && localUncomp === 0;
    const matches =
      localCrc === entry.crc &&
      localComp === entry.compressedSize &&
      localUncomp === entry.uncompressedSize;
    if (!zeroFilled && !matches) {
      fail(
        "ZIP_ENTRY_MISMATCH",
        `条目 ${entry.name} 的本地头 CRC/长度与中央目录不一致`,
      );
    }
  }
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > rangeEnd) {
    fail("ZIP_ENTRY_OVERLAP", `条目 ${entry.name} 的数据越过下一条目起点`);
  }
  let descriptorEnd = dataEnd;
  if (hasDescriptor) {
    const remain = rangeEnd - dataEnd;
    let crcOff: number;
    if (remain === 16) {
      if (u32(buf, dataEnd) !== DD_SIG) {
        fail("ZIP_STRUCTURE_INVALID", `条目 ${entry.name} 的数据描述符损坏`);
      }
      crcOff = dataEnd + 4;
    } else if (remain === 12) {
      crcOff = dataEnd;
    } else {
      fail(
        "ZIP_STRUCTURE_INVALID",
        `条目 ${entry.name} 的数据描述符长度非法`,
      );
    }
    const ddCrc = u32(buf, crcOff);
    const ddComp = u32(buf, crcOff + 4);
    const ddUncomp = u32(buf, crcOff + 8);
    if (
      ddCrc !== entry.crc ||
      ddComp !== entry.compressedSize ||
      ddUncomp !== entry.uncompressedSize
    ) {
      fail(
        "ZIP_ENTRY_MISMATCH",
        `条目 ${entry.name} 的数据描述符与中央目录不一致`,
      );
    }
    descriptorEnd = crcOff + 12;
  }
  return { dataStart, dataEnd, descriptorEnd };
}

function extractEntry(buf: Uint8Array, entry: CentralEntry, dataStart: number): Uint8Array {
  const raw = buf.subarray(dataStart, dataStart + entry.compressedSize);
  let data: Uint8Array;
  if (entry.method === METHOD_STORED) {
    data = raw;
  } else {
    try {
      data = new Uint8Array(inflateRawSync(raw));
    } catch {
      fail("ZIP_ENTRY_SIZE_MISMATCH", `条目 ${entry.name} 解压失败`);
    }
  }
  if (data.length !== entry.uncompressedSize) {
    fail(
      "ZIP_ENTRY_SIZE_MISMATCH",
      `条目 ${entry.name} 解压长度与声明不符`,
    );
  }
  if (crc32(data) !== entry.crc) {
    fail("ZIP_ENTRY_CRC_MISMATCH", `条目 ${entry.name} 的 CRC 校验失败`);
  }
  return data;
}

/**
 * 解析并完整校验一个 ZIP 归档（普通 ZIP，非 ZIP64/加密/分卷）。
 * 校验失败时抛出 ZipError。
 */
export function readZipArchive(buf: Uint8Array): ZipArchive {
  if (buf.length < EOCD_MIN_LEN) {
    fail("NOT_ZIP", "文件太小，不是 ZIP 归档");
  }
  const eocdOff = findEocd(buf);
  const diskNo = u16(buf, eocdOff + 4);
  const cdDisk = u16(buf, eocdOff + 6);
  const entriesThisDisk = u16(buf, eocdOff + 8);
  const entriesTotal = u16(buf, eocdOff + 10);
  const cdSize = u32(buf, eocdOff + 12);
  const cdOffset = u32(buf, eocdOff + 16);
  if (
    entriesThisDisk === 0xffff ||
    entriesTotal === 0xffff ||
    cdSize === 0xffffffff ||
    cdOffset === 0xffffffff
  ) {
    fail("ZIP_UNSUPPORTED_FEATURE", "不支持 ZIP64 归档");
  }
  if (diskNo !== 0 || cdDisk !== 0 || entriesThisDisk !== entriesTotal) {
    fail("ZIP_UNSUPPORTED_FEATURE", "不支持分卷归档");
  }
  if (cdOffset + cdSize !== eocdOff) {
    fail("ZIP_STRUCTURE_INVALID", "中央目录与结束记录不连续");
  }
  const central = parseCentralDirectory(buf, cdOffset, cdSize, entriesTotal);

  const sorted = [...central].sort(
    (a, b) => a.localHeaderOffset - b.localHeaderOffset,
  );
  const entries: ZipEntry[] = [];
  let cursor = 0;
  for (let i = 0; i < sorted.length; i++) {
    const entry = sorted[i]!;
    if (entry.localHeaderOffset < cursor) {
      fail("ZIP_ENTRY_OVERLAP", `条目 ${entry.name} 的范围与前一条目重叠`);
    }
    if (entry.localHeaderOffset > cursor) {
      fail(
        "ZIP_STRUCTURE_INVALID",
        "归档含前置数据、拼接内容或未列入中央目录的本地条目",
      );
    }
    const next = sorted[i + 1];
    const boundary = next ? next.localHeaderOffset : cdOffset;
    const local = parseLocalAndData(buf, entry, boundary);
    if (local.descriptorEnd > boundary) {
      fail("ZIP_ENTRY_OVERLAP", `条目 ${entry.name} 越过下一条目起点`);
    }
    const data = extractEntry(buf, entry, local.dataStart);
    entries.push({
      name: entry.name,
      isDirectory: entry.name.endsWith("/"),
      data,
    });
    cursor = local.descriptorEnd;
  }
  if (cursor !== cdOffset) {
    fail(
      "ZIP_STRUCTURE_INVALID",
      "归档含未列入中央目录的数据或拼接内容",
    );
  }
  return { entries };
}
