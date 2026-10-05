import { iterateSegments, JpegSegment } from './jpeg';
import { makeReader, parseIfd, parseEntries, Ifd, IfdEntry, TiffReader } from './tiff';

const TAG_EXIF_IFD = 0x8769;
const TAG_INTEROP_IFD = 0xa005;
const TAG_GPS_IFD = 0x8825;
const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"

interface IfdRecord {
  ifd: Ifd;
  entries: IfdEntry[];
}

function isExifApp1(data: Uint8Array, seg: JpegSegment): boolean {
  if (seg.marker !== 0xe1 || seg.payloadStart < 0) return false;
  if (seg.payloadEnd - seg.payloadStart < EXIF_HEADER.length) return false;
  for (let i = 0; i < EXIF_HEADER.length; i++) {
    if (data[seg.payloadStart + i] !== EXIF_HEADER[i]) return false;
  }
  return true;
}

/** Read the target offset of a directory-pointer entry (inline SHORT or LONG). */
function pointerTarget(reader: TiffReader, entry: IfdEntry): number {
  if (entry.type === 3 && entry.count === 1) {
    return reader.u16(entry.recordOffset + 8);
  }
  return reader.u32(entry.recordOffset + 8);
}

/**
 * Walk the IFD graph starting from `roots`, following directory-pointer tags
 * and next-IFD chains. When `followGps` is false, GPS pointer tags are not
 * followed; their targets are reported via `gpsRoots` instead.
 */
function walkIfds(
  reader: TiffReader,
  roots: number[],
  tiffLen: number,
  followGps: boolean,
): { ifds: IfdRecord[]; gpsRoots: number[] } {
  const ifds: IfdRecord[] = [];
  const gpsRoots: number[] = [];
  const visited = new Set<number>();
  const queue = [...roots];
  while (queue.length > 0) {
    const offset = queue.shift() as number;
    if (offset <= 0 || offset + 2 > tiffLen || visited.has(offset)) continue;
    visited.add(offset);
    const ifd = parseIfd(reader, offset);
    if (ifd.nextOffsetPos + 4 > tiffLen) continue;
    const entries = parseEntries(reader, ifd);
    ifds.push({ ifd, entries });
    for (const entry of entries) {
      const isPointer =
        entry.tag === TAG_EXIF_IFD ||
        entry.tag === TAG_INTEROP_IFD ||
        entry.tag === TAG_GPS_IFD;
      if (!isPointer) continue;
      const target = pointerTarget(reader, entry);
      if (target <= 0) continue;
      if (entry.tag === TAG_GPS_IFD && !followGps) {
        gpsRoots.push(target);
      } else if (!visited.has(target)) {
        queue.push(target);
      }
    }
    if (ifd.next !== 0 && !visited.has(ifd.next)) {
      queue.push(ifd.next);
    }
  }
  return { ifds, gpsRoots };
}

function clampRange(offset: number, size: number, tiffLen: number): [number, number] {
  const start = Math.max(0, Math.min(offset, tiffLen));
  const end = Math.max(start, Math.min(offset + size, tiffLen));
  return [start, end];
}

/** Zero [offset, offset+size) except bytes covered by `keep` intervals. */
function zeroExclusive(
  out: Uint8Array,
  base: number,
  offset: number,
  size: number,
  tiffLen: number,
  keep: Array<[number, number]>,
): void {
  const [start, end] = clampRange(offset, size, tiffLen);
  let cursor = start;
  for (const [ks, ke] of keep) {
    if (ke <= cursor) continue;
    if (ks >= end) break;
    if (ks > cursor) {
      out.fill(0, base + cursor, base + Math.min(ks, end));
    }
    cursor = Math.max(cursor, ke);
    if (cursor >= end) return;
  }
  if (cursor < end) {
    out.fill(0, base + cursor, base + end);
  }
}

function writeU16(out: Uint8Array, pos: number, value: number, littleEndian: boolean): void {
  if (littleEndian) {
    out[pos] = value & 0xff;
    out[pos + 1] = (value >>> 8) & 0xff;
  } else {
    out[pos] = (value >>> 8) & 0xff;
    out[pos + 1] = value & 0xff;
  }
}

/** Remove GPSInfo pointer entries from a retained IFD, compacting in place. */
function removeGpsPointerEntries(
  out: Uint8Array,
  base: number,
  record: IfdRecord,
  littleEndian: boolean,
): void {
  const { ifd, entries } = record;
  const kept = entries.filter((e) => e.tag !== TAG_GPS_IFD);
  if (kept.length === entries.length) return;
  const recordsStart = base + ifd.offset + 2;
  const packed = new Uint8Array(kept.length * 12);
  kept.forEach((entry, i) => {
    packed.set(out.subarray(base + entry.recordOffset, base + entry.recordOffset + 12), i * 12);
  });
  const nextBytes = out.slice(base + ifd.nextOffsetPos, base + ifd.nextOffsetPos + 4);
  out.set(packed, recordsStart);
  writeU16(out, base + ifd.offset, kept.length, littleEndian);
  const newNextPos = recordsStart + kept.length * 12;
  out.set(nextBytes, newNextPos);
  out.fill(0, newNextPos + 4, base + ifd.nextOffsetPos + 4);
}

/** Strip GPS data from a single EXIF (TIFF) payload, in place. */
function stripExifSegment(out: Uint8Array, base: number, tiffLen: number): void {
  if (tiffLen < 8) return;
  const isII = out[base] === 0x49 && out[base + 1] === 0x49;
  const isMM = out[base] === 0x4d && out[base + 1] === 0x4d;
  if (!isII && !isMM) return;
  const reader = makeReader(out, base);
  if (reader.u16(2) !== 42) return;

  const { ifds: retained, gpsRoots } = walkIfds(reader, [reader.u32(4)], tiffLen, false);
  if (gpsRoots.length === 0) return;
  const { ifds: gpsIfds } = walkIfds(reader, gpsRoots, tiffLen, true);

  // External value ranges of retained (non-GPS) entries, sorted for sweeping.
  const keptRanges: Array<[number, number]> = [];
  for (const { entries } of retained) {
    for (const entry of entries) {
      if (entry.tag === TAG_GPS_IFD || entry.inline || entry.valueSize <= 0) continue;
      keptRanges.push(clampRange(entry.valueOffset, entry.valueSize, tiffLen));
    }
  }
  keptRanges.sort((a, b) => a[0] - b[0]);

  // Zero GPS directory tables (count + entries + next pointer).
  for (const { ifd } of gpsIfds) {
    const [start, end] = clampRange(ifd.offset, ifd.nextOffsetPos + 4 - ifd.offset, tiffLen);
    out.fill(0, base + start, base + end);
  }
  // Zero GPS-only external values, preserving bytes shared with kept values.
  for (const { entries } of gpsIfds) {
    for (const entry of entries) {
      if (entry.inline || entry.valueSize <= 0) continue;
      zeroExclusive(out, base, entry.valueOffset, entry.valueSize, tiffLen, keptRanges);
    }
  }
  // Remove GPSInfo pointer entries from retained IFDs.
  for (const record of retained) {
    removeGpsPointerEntries(out, base, record, reader.littleEndian);
  }
}

/**
 * Strip all GPS information from the EXIF segments of a JPEG image.
 *
 * @param input JPEG file bytes. Never modified.
 * @returns A new Uint8Array with GPS data removed. Byte-identical to the
 *          input when no GPS data is present.
 */
export function stripGps(input: Uint8Array): Uint8Array {
  const out = input.slice();
  for (const seg of iterateSegments(input)) {
    if (!isExifApp1(input, seg)) continue;
    stripExifSegment(out, seg.payloadStart + EXIF_HEADER.length, seg.payloadEnd - seg.payloadStart - EXIF_HEADER.length);
  }
  return out;
}
