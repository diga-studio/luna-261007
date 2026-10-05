import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripGps } from '../src/index';
import { iterateSegments } from '../src/jpeg';
import { makeReader, parseIfd, parseEntries, IfdEntry } from '../src/tiff';
import { TiffBuilder, exifSegment, jpeg, segment, concat } from './helpers';

// ---- Layout offsets shared by both endianness fixtures ----
const OFF_MAKE = 0x100; // 6 bytes ASCII "CAMERA"
const OFF_UNKNOWN = 0x120; // 16 bytes unknown type-12 value
const OFF_RATIONAL = 0x140; // 8 bytes retained rational (0x140-0x148)
const OFF_GPS_ALT = 0x144; // 8 bytes GPS altitude, shares 0x144-0x148
const OFF_GPS_LAT = 0x160; // 24 bytes GPS-only latitude
const OFF_EXIF_IFD = 0x180;
const OFF_INTEROP_IFD = 0x1c0;
const OFF_GPS_IFD = 0x200;
const OFF_IFD1 = 0x280;

const MAKE_BYTES = [0x43, 0x41, 0x4d, 0x45, 0x52, 0x41]; // "CAMERA"
const UNKNOWN_BYTES = Array.from({ length: 16 }, (_, i) => 0xa0 + i);
const RATIONAL_BYTES = [1, 2, 3, 4, 5, 6, 7, 8];
const GPS_ALT_BYTES = [0xaa, 0xbb, 0xcc, 0xdd, 0x11, 0x22, 0x33, 0x44];
const GPS_LAT_BYTES = Array.from({ length: 24 }, (_, i) => 0x50 + i);

function buildTiff(littleEndian: boolean): Uint8Array {
  const b = new TiffBuilder(littleEndian);
  b.setIfd0Offset(8);
  // Non-sequential directories: IFD1 sits after the GPS IFD.
  b.ifd(OFF_IFD1, [{ tag: 0x0103, type: 3, count: 1, inline: [6, 0] }]);
  b.ifd(OFF_GPS_IFD, [
    { tag: 0x0000, type: 1, count: 4, inline: [2, 3, 0, 0] },
    { tag: 0x0002, type: 5, count: 3, external: OFF_GPS_LAT },
    { tag: 0x0006, type: 5, count: 1, external: OFF_GPS_ALT },
  ]);
  b.ifd(OFF_INTEROP_IFD, [{ tag: 0x0001, type: 2, count: 4, inline: [0x52, 0x39, 0x38, 0x00] }]);
  b.ifd(OFF_EXIF_IFD, [
    { tag: 0x9000, type: 7, count: 4, inline: [0x30, 0x32, 0x33, 0x30] },
    { tag: 0xc003, type: 5, count: 1, external: OFF_RATIONAL },
    { tag: 0xa005, type: 4, count: 1, inline: u32bytes(OFF_INTEROP_IFD, littleEndian) },
  ]);
  b.ifd(8, [
    { tag: 0x010f, type: 2, count: 6, external: OFF_MAKE },
    { tag: 0xc001, type: 7, count: 4, inline: [1, 2, 3, 4] },
    { tag: 0xc002, type: 12, count: 2, external: OFF_UNKNOWN },
    { tag: 0x8769, type: 4, count: 1, inline: u32bytes(OFF_EXIF_IFD, littleEndian) },
    { tag: 0x8825, type: 4, count: 1, inline: u32bytes(OFF_GPS_IFD, littleEndian) },
  ], OFF_IFD1);
  // Value areas (deliberately out of order relative to directories).
  b.raw(OFF_MAKE, MAKE_BYTES);
  b.raw(OFF_UNKNOWN, UNKNOWN_BYTES);
  b.raw(OFF_RATIONAL, RATIONAL_BYTES);
  b.raw(OFF_GPS_ALT, GPS_ALT_BYTES); // overwrites 0x144-0x148 shared tail
  b.raw(OFF_GPS_LAT, GPS_LAT_BYTES);
  return b.bytes();
}

function u32bytes(v: number, le: boolean): number[] {
  return le
    ? [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]
    : [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}

function buildJpeg(littleEndian: boolean): Uint8Array {
  return jpeg(
    segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00]), // APP0 "JFIF\0"
    exifSegment(buildTiff(littleEndian)),
    segment(0xda, [0x01, 0x00]), // SOS header
    [0x11, 0x22, 0xff, 0x00, 0x33, 0xff, 0xd4, 0x44], // scan data w/ escape + RST4
  );
}

/** Extract the first EXIF TIFF payload (and its base offset) from a JPEG. */
function firstExif(j: Uint8Array): { tiff: Uint8Array; base: number } {
  for (const seg of iterateSegments(j)) {
    if (seg.marker !== 0xe1 || seg.payloadStart < 0) continue;
    if (j[seg.payloadStart] === 0x45 && j[seg.payloadStart + 1] === 0x78) {
      const base = seg.payloadStart + 6;
      return { tiff: j.subarray(base, seg.payloadEnd), base };
    }
  }
  throw new Error('no EXIF segment found');
}

function entriesAt(tiff: Uint8Array, offset: number): IfdEntry[] {
  const reader = makeReader(tiff, 0);
  return parseEntries(reader, parseIfd(reader, offset));
}

function entryBytes(tiff: Uint8Array, entry: IfdEntry): number[] {
  return [...tiff.subarray(entry.valueOffset, entry.valueOffset + entry.valueSize)];
}

for (const littleEndian of [true, false]) {
  const name = littleEndian ? 'little-endian' : 'big-endian';

  test(`strip GPS from ${name} EXIF`, () => {
    const input = buildJpeg(littleEndian);
    const inputSnapshot = input.slice();
    const out = stripGps(input);

    // Input untouched, output is an independent array of the same length.
    assert.deepStrictEqual(input, inputSnapshot);
    assert.notStrictEqual(out, input);
    assert.strictEqual(out.length, input.length);

    const { tiff } = firstExif(out);

    // IFD0: GPS pointer gone, other entries preserved with type/count/value.
    const ifd0 = entriesAt(tiff, 8);
    assert.deepStrictEqual(ifd0.map((e) => e.tag).sort((a, b) => a - b),
      [0x010f, 0x8769, 0xc001, 0xc002]);
    const byTag = new Map(ifd0.map((e) => [e.tag, e]));
    assert.strictEqual(byTag.get(0x010f)!.type, 2);
    assert.strictEqual(byTag.get(0x010f)!.count, 6);
    assert.deepStrictEqual(entryBytes(tiff, byTag.get(0x010f)!), MAKE_BYTES);
    assert.deepStrictEqual(entryBytes(tiff, byTag.get(0xc001)!), [1, 2, 3, 4]);
    assert.strictEqual(byTag.get(0xc002)!.type, 12);
    assert.strictEqual(byTag.get(0xc002)!.count, 2);
    assert.deepStrictEqual(entryBytes(tiff, byTag.get(0xc002)!), UNKNOWN_BYTES);

    // ExifIFD reachable, values intact, InteropIFD chain preserved.
    const exifPtr = byTag.get(0x8769)!;
    const exifIfd = entriesAt(tiff, exifPtr.valueOffset === exifPtr.recordOffset + 8
      ? readPtr(tiff, exifPtr) : exifPtr.valueOffset);
    const exifByTag = new Map(exifIfd.map((e) => [e.tag, e]));
    assert.deepStrictEqual(entryBytes(tiff, exifByTag.get(0x9000)!), [0x30, 0x32, 0x33, 0x30]);
    assert.deepStrictEqual(entryBytes(tiff, exifByTag.get(0xc003)!),
      [1, 2, 3, 4, 0xaa, 0xbb, 0xcc, 0xdd]);
    const interop = entriesAt(tiff, readPtr(tiff, exifByTag.get(0xa005)!));
    assert.deepStrictEqual(entryBytes(tiff, interop[0]), [0x52, 0x39, 0x38, 0x00]);

    // Shared value area: retained bytes kept, GPS-exclusive tail zeroed.
    assert.deepStrictEqual([...tiff.subarray(OFF_RATIONAL, OFF_RATIONAL + 4)], [1, 2, 3, 4]);
    assert.deepStrictEqual([...tiff.subarray(0x144, 0x148)], [0xaa, 0xbb, 0xcc, 0xdd]);
    assert.deepStrictEqual([...tiff.subarray(0x148, 0x14c)], [0, 0, 0, 0]);
    // GPS-only value area fully zeroed.
    assert.deepStrictEqual([...tiff.subarray(OFF_GPS_LAT, OFF_GPS_LAT + 24)], new Array(24).fill(0));
    // GPS directory table fully zeroed.
    assert.deepStrictEqual([...tiff.subarray(OFF_GPS_IFD, OFF_GPS_IFD + 0x2a)], new Array(0x2a).fill(0));

    // IFD1 still reachable through IFD0's next chain.
    const reader = makeReader(tiff, 0);
    const ifd0Parsed = parseIfd(reader, 8);
    assert.strictEqual(ifd0Parsed.next, OFF_IFD1);
    const ifd1 = entriesAt(tiff, OFF_IFD1);
    assert.strictEqual(ifd1.length, 1);
    assert.strictEqual(ifd1[0].tag, 0x0103);
    assert.deepStrictEqual(entryBytes(tiff, ifd1[0]), [6, 0]);

    // Idempotent.
    const again = stripGps(out);
    assert.deepStrictEqual(again, out);
  });
}

function readPtr(tiff: Uint8Array, entry: IfdEntry): number {
  const reader = makeReader(tiff, 0);
  return reader.u32(entry.recordOffset + 8);
}

test('no GPS: output is byte-identical to input', () => {
  const b = new TiffBuilder(true);
  b.setIfd0Offset(8);
  b.ifd(8, [
    { tag: 0x010f, type: 2, count: 6, external: 0x100 },
    { tag: 0xc001, type: 7, count: 4, inline: [9, 9, 9, 9] },
  ]);
  b.raw(0x100, MAKE_BYTES);
  const input = jpeg(exifSegment(b.bytes()), segment(0xda, [0x01]), [0xff, 0x00, 0x42]);
  const out = stripGps(input);
  assert.deepStrictEqual(out, input);
});
