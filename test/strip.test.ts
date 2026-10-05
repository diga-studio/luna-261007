import { test } from "node:test";
import * as assert from "node:assert/strict";
import { stripGps } from "../src/index";
import { parseJpegSegments } from "../src/jpeg";
import {
  Writer,
  packInline,
  writeTiffHeader,
  ifdEntry,
  concat,
  exifSegment,
  segment,
  readU32,
  readIfd,
  containsBytes,
} from "./helpers";

const SOI = new Uint8Array([0xff, 0xd8]);
const EOI = new Uint8Array([0xff, 0xd9]);

function ascii(s: string): number[] {
  return Array.from(s, (c) => c.charCodeAt(0));
}

/** Pull the TIFF payload out of every EXIF APP1 segment of a JPEG
 *  that contains no scan data. */
function extractExifTiffs(jpeg: Uint8Array): Uint8Array[] {
  const tiffs: Uint8Array[] = [];
  let pos = 2;
  while (pos + 4 <= jpeg.length && jpeg[pos] === 0xff) {
    const marker = jpeg[pos + 1];
    if (marker === 0xd9 || marker === 0xda) break;
    const len = (jpeg[pos + 2] << 8) | jpeg[pos + 3];
    if (
      marker === 0xe1 &&
      jpeg[pos + 4] === 0x45 &&
      jpeg[pos + 5] === 0x78 &&
      jpeg[pos + 8] === 0 &&
      jpeg[pos + 9] === 0
    ) {
      tiffs.push(jpeg.subarray(pos + 10, pos + 2 + len));
    }
    pos += 2 + len;
  }
  return tiffs;
}

// Unique marker byte patterns used to detect GPS residue.
const GPS_TAIL = new Uint8Array(ascii("GpStAiL!"));
const GPS_ALT = new Uint8Array(ascii("GPSALT-GPSALT-GPSALT-GPS")); // 24 bytes
const GPS_NEXT_SECRET = new Uint8Array(ascii("GPSNEXT-SECRET")); // 14 bytes
const SHARED_HEAD = Array.from({ length: 24 }, (_, i) => 0x60 + i);

/** Complex little-endian TIFF: non-sequential directories, unknown
 *  tags, inline and external values, a GPS subtree with its own next
 *  chain, and a value region partially shared between a GPS tag and
 *  a normal tag. */
function buildLittleEndianTiff(): Uint8Array {
  const w = new Writer(true);
  writeTiffHeader(w);
  // IFD0 at offset 8.
  w.u16(5);
  ifdEntry(w, 0x0100, 4, 1, 1024); // ImageWidth, inline
  const makeField = ifdEntry(w, 0x010f, 2, 6, 0); // Make, external
  const exifField = ifdEntry(w, 0x8769, 4, 1, 0); // ExifIFD pointer
  const gpsField = ifdEntry(w, 0x8825, 4, 1, 0); // GPSInfo pointer
  const sharedField = ifdEntry(w, 0xc4a5, 1, 24, 0); // unknown tag, external
  const ifd0NextAt = w.offset;
  w.u32(0); // next IFD, patched to IFD1

  // GPS IFD (placed before everything else: non-sequential layout).
  const gpsIfd = w.offset;
  w.u16(3);
  ifdEntry(w, 0x0000, 1, 4, packInline(true, [2, 3, 0, 0])); // version
  const gpsLatField = ifdEntry(w, 0x0002, 5, 3, 0); // latitude, external
  const gpsAltField = ifdEntry(w, 0x0007, 5, 3, 0); // altitude, external
  const gpsNextAt = w.offset;
  w.u32(0); // GPS next chain, patched below

  // Shared value region: 24 normal bytes followed by the GPS-only tail.
  const shared = w.offset;
  w.raw(SHARED_HEAD);
  w.raw(GPS_TAIL);

  // GPS next-chain IFD with its own external secret value.
  const gpsNextIfd = w.offset;
  w.u16(1);
  const gpsNextValField = ifdEntry(w, 0x0001, 2, 14, 0);
  w.u32(0);
  const gpsNextVal = w.offset;
  w.raw(GPS_NEXT_SECRET);

  // GPS altitude value (GPS-exclusive external region).
  const gpsAlt = w.offset;
  w.raw(GPS_ALT);

  // IFD1 (next chain of IFD0).
  const ifd1 = w.offset;
  w.u16(1);
  const modelField = ifdEntry(w, 0x0110, 2, 6, 0); // Model, external
  w.u32(0);

  // ExifIFD.
  const exifIfd = w.offset;
  w.u16(3);
  ifdEntry(w, 0x9000, 7, 4, packInline(true, ascii("0232"))); // ExifVersion
  const expField = ifdEntry(w, 0x829a, 5, 1, 0); // ExposureTime, external
  const interopField = ifdEntry(w, 0xa005, 4, 1, 0); // InteropIFD pointer
  w.u32(0);

  // InteropIFD.
  const interopIfd = w.offset;
  w.u16(1);
  ifdEntry(w, 0x0001, 2, 4, packInline(true, ascii("R98\0")));
  w.u32(0);

  // External values for retained tags (scrambled order).
  const modelVal = w.offset;
  w.raw(ascii("MODEL\0"));
  const makeVal = w.offset;
  w.raw(ascii("ACME\0\0"));
  const expVal = w.offset;
  w.u32(1);
  w.u32(60);

  // Patch offsets.
  w.patch32(makeField, makeVal);
  w.patch32(exifField, exifIfd);
  w.patch32(gpsField, gpsIfd);
  w.patch32(sharedField, shared);
  w.patch32(ifd0NextAt, ifd1);
  w.patch32(gpsLatField, shared + 8); // overlaps the normal tag region
  w.patch32(gpsAltField, gpsAlt);
  w.patch32(gpsNextAt, gpsNextIfd);
  w.patch32(gpsNextValField, gpsNextVal);
  w.patch32(modelField, modelVal);
  w.patch32(expField, expVal);
  w.patch32(interopField, interopIfd);
  return w.toBytes();
}

test("little-endian: GPS subtree removed, non-GPS data preserved", () => {
  const tiff = buildLittleEndianTiff();
  const jpeg = concat(SOI, exifSegment(tiff), EOI);
  const original = jpeg.slice();

  const stripped = stripGps(jpeg);

  // Input untouched.
  assert.deepEqual(jpeg, original);
  // GPS-exclusive bytes are gone from the output entirely.
  assert.equal(containsBytes(stripped, GPS_TAIL), false);
  assert.equal(containsBytes(stripped, GPS_ALT), false);
  assert.equal(containsBytes(stripped, GPS_NEXT_SECRET), false);
  // The shared region's retained part survives intact.
  assert.equal(containsBytes(stripped, new Uint8Array(SHARED_HEAD)), true);

  const tiffs = extractExifTiffs(stripped);
  assert.equal(tiffs.length, 1);
  const out = tiffs[0];
  assert.equal(out[0], 0x49); // still little-endian

  // IFD0: GPS pointer gone, everything else intact.
  const ifd0 = readIfd(out, true, readU32(out, 4, true));
  const tags0 = ifd0.entries.map((e) => e.tag);
  assert.deepEqual(tags0, [0x0100, 0x010f, 0x8769, 0xc4a5]);
  const width = ifd0.entries[0];
  assert.equal(width.type, 4);
  assert.equal(width.count, 1);
  assert.equal(width.offset, 1024);
  const make = ifd0.entries[1];
  assert.equal(make.type, 2);
  assert.equal(make.count, 6);
  assert.deepEqual(Array.from(out.subarray(make.offset, make.offset + 6)), [
    ...ascii("ACME"),
    0,
    0,
  ]);
  const shared = ifd0.entries[3];
  assert.equal(shared.type, 1);
  assert.equal(shared.count, 24);
  assert.deepEqual(
    Array.from(out.subarray(shared.offset, shared.offset + 24)),
    SHARED_HEAD,
  );

  // Next chain: IFD1 with the Model tag.
  assert.notEqual(ifd0.nextOffset, 0);
  const ifd1 = readIfd(out, true, ifd0.nextOffset);
  assert.equal(ifd1.entries.length, 1);
  assert.equal(ifd1.entries[0].tag, 0x0110);
  assert.deepEqual(
    Array.from(out.subarray(ifd1.entries[0].offset, ifd1.entries[0].offset + 6)),
    ascii("MODEL\0"),
  );
  assert.equal(ifd1.nextOffset, 0);

  // ExifIFD reachable through 0x8769, InteropIFD through 0xa005.
  const exifPtr = ifd0.entries[2];
  const exifIfd = readIfd(out, true, exifPtr.offset);
  assert.deepEqual(
    exifIfd.entries.map((e) => e.tag),
    [0x9000, 0x829a, 0xa005],
  );
  assert.deepEqual(Array.from(exifIfd.entries[0].field), [
    ...ascii("0232"),
  ]);
  const exp = exifIfd.entries[1];
  assert.equal(exp.type, 5);
  assert.equal(exp.count, 1);
  assert.equal(readU32(out, exp.offset, true), 1);
  assert.equal(readU32(out, exp.offset + 4, true), 60);
  const interopIfd = readIfd(out, true, exifIfd.entries[2].offset);
  assert.equal(interopIfd.entries.length, 1);
  assert.equal(interopIfd.entries[0].tag, 0x0001);
  assert.deepEqual(Array.from(interopIfd.entries[0].field), [
    ...ascii("R98\0"),
  ]);

  // Idempotent: a second pass changes nothing.
  assert.deepEqual(stripGps(stripped), stripped);
});

/** Big-endian TIFF with an unknown type-12 tag and GPS data. */
function buildBigEndianTiff(): Uint8Array {
  const w = new Writer(false);
  writeTiffHeader(w);
  w.u16(3);
  ifdEntry(w, 0x0111, 4, 1, 273); // StripOffsets, inline
  const dblField = ifdEntry(w, 0xc0de, 12, 2, 0); // unknown, external
  const gpsField = ifdEntry(w, 0x8825, 4, 1, 0); // GPSInfo pointer
  w.u32(0);

  const gpsIfd = w.offset;
  w.u16(2);
  ifdEntry(w, 0x0005, 1, 1, packInline(false, [1])); // altitude ref
  const gpsDateField = ifdEntry(w, 0x001d, 2, 14, 0); // date stamp
  w.u32(0);

  const gpsDate = w.offset;
  w.raw(GPS_NEXT_SECRET);

  const dblVal = w.offset;
  w.raw([0x3f, 0xf0, 0, 0, 0, 0, 0, 0]); // 1.0
  w.raw([0x40, 0, 0, 0, 0, 0, 0, 0]); // 2.0

  w.patch32(dblField, dblVal);
  w.patch32(gpsField, gpsIfd);
  w.patch32(gpsDateField, gpsDate);
  return w.toBytes();
}

test("big-endian: GPS removed, unknown type-12 tag preserved", () => {
  const tiff = buildBigEndianTiff();
  const jpeg = concat(SOI, exifSegment(tiff), EOI);
  const original = jpeg.slice();

  const stripped = stripGps(jpeg);

  assert.deepEqual(jpeg, original);
  assert.equal(containsBytes(stripped, GPS_NEXT_SECRET), false);

  const out = extractExifTiffs(stripped)[0];
  assert.equal(out[0], 0x4d); // still big-endian
  const ifd0 = readIfd(out, false, readU32(out, 4, false));
  assert.deepEqual(
    ifd0.entries.map((e) => e.tag),
    [0x0111, 0xc0de],
  );
  const dbl = ifd0.entries[1];
  assert.equal(dbl.type, 12);
  assert.equal(dbl.count, 2);
  assert.deepEqual(
    Array.from(out.subarray(dbl.offset, dbl.offset + 16)),
    [0x3f, 0xf0, 0, 0, 0, 0, 0, 0, 0x40, 0, 0, 0, 0, 0, 0, 0],
  );
  assert.equal(ifd0.nextOffset, 0);
  assert.deepEqual(stripGps(stripped), stripped);
});

test("no GPS anywhere: output is byte-identical to input", () => {
  const w = new Writer(true);
  writeTiffHeader(w);
  w.u16(2);
  ifdEntry(w, 0x0100, 4, 1, 640);
  const makeField = ifdEntry(w, 0x010f, 2, 5, 0);
  w.u32(0);
  const makeVal = w.offset;
  w.raw(ascii("ACME\0"));
  w.patch32(makeField, makeVal);

  const app0 = segment(0xe0, new Uint8Array(ascii("JFIF\0")));
  const jpeg = concat(SOI, app0, exifSegment(w.toBytes()), EOI);
  const stripped = stripGps(jpeg);
  assert.deepEqual(stripped, jpeg);
  assert.notEqual(stripped, jpeg); // independent copy
});

const GPS1_MARK = new Uint8Array(ascii("GPS1-LAT-SECRET!")); // 16 bytes
const GPS2_MARK = new Uint8Array(ascii("GPS2-DATE-SECRET")); // 16 bytes

function buildGpsOnlyTiff(little: boolean, mark: Uint8Array): Uint8Array {
  const w = new Writer(little);
  writeTiffHeader(w);
  w.u16(2);
  ifdEntry(w, 0x0100, 4, 1, 800);
  const gpsField = ifdEntry(w, 0x8825, 4, 1, 0);
  w.u32(0);
  const gpsIfd = w.offset;
  w.u16(1);
  const markField = ifdEntry(w, 0x0002, 5, 2, 0);
  w.u32(0);
  const markVal = w.offset;
  w.raw(mark);
  w.patch32(gpsField, gpsIfd);
  w.patch32(markField, markVal);
  return w.toBytes();
}

test("multi-scan JPEG: GPS stripped everywhere, scans and segments intact", () => {
  const app0 = segment(0xe0, new Uint8Array(ascii("JFIF\0")));
  const nonExifApp1 = segment(
    0xe1,
    new Uint8Array([...ascii("NotExif"), 0xff, 0x00, 0xff, 0xd8]),
  );
  const exif1 = exifSegment(buildGpsOnlyTiff(true, GPS1_MARK));
  const exif2 = exifSegment(buildGpsOnlyTiff(false, GPS2_MARK));
  const sosHeader1 = new Uint8Array([0x01, 0x01, 0x11, 0x00, 0x3f, 0x00]);
  const sosHeader2 = new Uint8Array([0x01, 0x01, 0x11, 0x00, 0x3f, 0x00]);
  // Scan 1 ends with 0xff padding bytes right before the next marker;
  // it contains an escaped FF00 and a restart marker FFD0.
  const scan1 = new Uint8Array([
    0x10, 0xff, 0x00, 0x20, 0xff, 0xd0, 0x30, 0xff, 0xff,
  ]);
  const scan2 = new Uint8Array([0x40, 0xff, 0x00, 0xff, 0xd7, 0x50]);

  const jpeg = concat(
    SOI,
    app0,
    exif1,
    nonExifApp1,
    segment(0xda, sosHeader1),
    scan1,
    exif2, // EXIF between two scans
    segment(0xda, sosHeader2),
    scan2,
    EOI,
  );
  const original = jpeg.slice();

  const stripped = stripGps(jpeg);

  assert.deepEqual(jpeg, original);
  assert.equal(containsBytes(stripped, GPS1_MARK), false);
  assert.equal(containsBytes(stripped, GPS2_MARK), false);

  // Segment layout is preserved; every non-EXIF segment is byte-identical.
  const inSegs = parseJpegSegments(jpeg);
  const outSegs = parseJpegSegments(stripped);
  assert.equal(outSegs.length, inSegs.length);
  let exifCount = 0;
  for (let i = 0; i < inSegs.length; i++) {
    const isExif =
      inSegs[i].marker === 0xe1 &&
      jpeg[inSegs[i].dataStart] === 0x45 &&
      jpeg[inSegs[i].dataStart + 1] === 0x78 &&
      jpeg[inSegs[i].dataStart + 4] === 0 &&
      jpeg[inSegs[i].dataStart + 5] === 0;
    if (isExif) {
      exifCount++;
      // The rewritten EXIF segment contains no GPS pointer tag 0x8825.
      const segBytes = stripped.subarray(outSegs[i].start, outSegs[i].end);
      assert.equal(containsBytes(segBytes, GPS1_MARK), false);
      assert.equal(containsBytes(segBytes, GPS2_MARK), false);
      const tiff = segBytes.subarray(10);
      const little = tiff[0] === 0x49;
      const ifd0 = readIfd(tiff, little, readU32(tiff, 4, little));
      assert.deepEqual(
        ifd0.entries.map((e) => e.tag),
        [0x0100],
      );
      continue;
    }
    assert.deepEqual(
      stripped.subarray(outSegs[i].start, outSegs[i].end),
      jpeg.subarray(inSegs[i].start, inSegs[i].end),
      `segment ${i} (marker 0x${inSegs[i].marker.toString(16)}) unchanged`,
    );
  }
  assert.equal(exifCount, 2);

  // Scan payloads (escaped bytes, restart markers, padding) are intact.
  assert.equal(containsBytes(stripped, scan1), true);
  assert.equal(containsBytes(stripped, scan2), true);

  // Idempotent over the whole multi-scan file.
  assert.deepEqual(stripGps(stripped), stripped);
});
