import { deflateRawSync } from "node:zlib";
import { crc32 } from "../../src/zip/crc32.js";

export interface FieldOverrides {
  crc?: number;
  compressedSize?: number;
  uncompressedSize?: number;
  flags?: number;
  method?: number;
  name?: string;
  versionNeeded?: number;
}

export interface EntrySpec {
  name: string;
  data?: Buffer | string;
  method?: 0 | 8;
  useDataDescriptor?: boolean;
  descriptorWithSignature?: boolean;
  utf8Flag?: boolean;
  local?: FieldOverrides;
  central?: FieldOverrides;
}

export interface ZipOptions {
  comment?: string;
  prefix?: Buffer;
  suffix?: Buffer;
  eocd?: {
    diskNumber?: number;
    cdStartDisk?: number;
    entriesThisDisk?: number;
    entriesTotal?: number;
    cdSize?: number;
    cdOffset?: number;
  };
  extraLocalRecords?: Buffer;
}

export function buildZip(entries: EntrySpec[], opts: ZipOptions = {}): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = opts.prefix ? opts.prefix.length : 0;
  if (opts.prefix) chunks.push(opts.prefix);

  for (const entry of entries) {
    const name = entry.local?.name ?? entry.name;
    const centralName = entry.central?.name ?? entry.name;
    const rawName = Buffer.from(name, "utf8");
    const rawCentralName = Buffer.from(centralName, "utf8");
    const plain = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(entry.data ?? "", "utf8");
    const method = entry.method ?? 8;
    const compressed = method === 8 ? deflateRawSync(plain) : plain;
    const crc = crc32(plain);
    const useDd = entry.useDataDescriptor ?? false;
    const utf8 = entry.utf8Flag ?? false;
    const baseFlags = (useDd ? 0x08 : 0) | (utf8 ? 0x800 : 0);

    const localFlags = entry.local?.flags ?? baseFlags;
    const centralFlags = entry.central?.flags ?? baseFlags;
    const localMethod = entry.local?.method ?? method;
    const centralMethod = entry.central?.method ?? method;

    const localCrc = entry.local?.crc ?? (useDd ? 0 : crc);
    const localCs = entry.local?.compressedSize ?? (useDd ? 0 : compressed.length);
    const localUs = entry.local?.uncompressedSize ?? (useDd ? 0 : plain.length);
    const centralCrc = entry.central?.crc ?? crc;
    const centralCs = entry.central?.compressedSize ?? compressed.length;
    const centralUs = entry.central?.uncompressedSize ?? plain.length;

    const localHeaderOffset = offset;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(entry.local?.versionNeeded ?? 20, 4);
    lh.writeUInt16LE(localFlags, 6);
    lh.writeUInt16LE(localMethod, 8);
    lh.writeUInt32LE(localCrc >>> 0, 14);
    lh.writeUInt32LE(localCs >>> 0, 18);
    lh.writeUInt32LE(localUs >>> 0, 22);
    lh.writeUInt16LE(rawName.length, 26);
    lh.writeUInt16LE(0, 28);
    chunks.push(lh, rawName, compressed);

    let descriptorLen = 0;
    if (useDd) {
      const withSig = entry.descriptorWithSignature ?? true;
      const dd = Buffer.alloc(withSig ? 16 : 12);
      let p = 0;
      if (withSig) {
        dd.writeUInt32LE(0x08074b50, 0);
        p = 4;
      }
      dd.writeUInt32LE(crc >>> 0, p);
      dd.writeUInt32LE(compressed.length, p + 4);
      dd.writeUInt32LE(plain.length, p + 8);
      chunks.push(dd);
      descriptorLen = dd.length;
    }

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(entry.central?.versionNeeded ?? 20, 6);
    ch.writeUInt16LE(centralFlags, 8);
    ch.writeUInt16LE(centralMethod, 10);
    ch.writeUInt32LE(centralCrc >>> 0, 16);
    ch.writeUInt32LE(centralCs >>> 0, 20);
    ch.writeUInt32LE(centralUs >>> 0, 24);
    ch.writeUInt16LE(rawCentralName.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(localHeaderOffset, 42);
    central.push(ch, rawCentralName);

    offset += 30 + rawName.length + compressed.length + descriptorLen;
  }

  if (opts.extraLocalRecords) {
    chunks.push(opts.extraLocalRecords);
    offset += opts.extraLocalRecords.length;
  }

  const cdOffset = offset;
  const cd = Buffer.concat(central);
  chunks.push(cd);
  offset += cd.length;

  const comment = Buffer.from(opts.comment ?? "", "utf8");
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(opts.eocd?.diskNumber ?? 0, 4);
  eocd.writeUInt16LE(opts.eocd?.cdStartDisk ?? 0, 6);
  eocd.writeUInt16LE(opts.eocd?.entriesThisDisk ?? entries.length, 8);
  eocd.writeUInt16LE(opts.eocd?.entriesTotal ?? entries.length, 10);
  eocd.writeUInt32LE(opts.eocd?.cdSize ?? cd.length, 12);
  eocd.writeUInt32LE(opts.eocd?.cdOffset ?? cdOffset, 16);
  eocd.writeUInt16LE(comment.length, 20);
  chunks.push(eocd, comment);
  if (opts.suffix) chunks.push(opts.suffix);

  return Buffer.concat(chunks);
}
