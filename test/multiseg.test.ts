import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripGps } from '../src/index';
import { iterateSegments } from '../src/jpeg';
import { TiffBuilder, exifSegment, jpeg, segment } from './helpers';

const GPS_IFD_OFF = 0x80;
const GPS_VAL_OFF = 0x100;
const GPS_VAL_LEN = 16;

/** Minimal EXIF TIFF with one normal tag and a GPS IFD with an external value. */
function exifWithGps(littleEndian: boolean, normalTag: number): Uint8Array {
  const b = new TiffBuilder(littleEndian);
  b.setIfd0Offset(8);
  b.ifd(GPS_IFD_OFF, [
    { tag: 0x0000, type: 1, count: 4, inline: [2, 3, 0, 0] },
    { tag: 0x0002, type: 5, count: 2, external: GPS_VAL_OFF },
  ]);
  b.raw(GPS_VAL_OFF, Array.from({ length: GPS_VAL_LEN }, (_, i) => 0x30 + i));
  b.ifd(8, [
    { tag: normalTag, type: 3, count: 1, inline: [7, 0] },
    {
      tag: 0x8825, type: 4, count: 1,
      inline: littleEndian ? [GPS_IFD_OFF, 0, 0, 0] : [0, 0, 0, GPS_IFD_OFF],
    },
  ]);
  return b.bytes();
}

// Scan data exercising FF00 escapes, restart markers, TEM, and 0xFF fill runs.
const SCAN1 = [0x11, 0xff, 0x00, 0x22, 0xff, 0xd0, 0x33, 0xff, 0xff, 0xff, 0x00, 0x44, 0xff, 0x01, 0x55];
const SCAN2 = [0x66, 0xff, 0xd7, 0x77, 0xff, 0xff, 0xd3, 0x88, 0xff, 0x00];
const APP1_NON_EXIF = [0x68, 0x74, 0x74, 0x70, 0x3a, 0x2f, 0x2f, 0x6e, 0x6f, 0x74, 0x2d, 0x78, 0x6d, 0x70];

function buildMultiScanJpeg(): Uint8Array {
  return jpeg(
    segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00]),
    exifSegment(exifWithGps(true, 0x010f)),
    segment(0xe1, APP1_NON_EXIF), // non-EXIF APP1, must be preserved
    segment(0xdb, [0x00, 0x01, 0x02, 0x03]), // DQT
    segment(0xda, [0x01, 0x00]), // SOS #1
    SCAN1,
    exifSegment(exifWithGps(false, 0x0110)), // EXIF between scans
    segment(0xda, [0x01, 0x00]), // SOS #2
    SCAN2,
  );
}

test('strips GPS from all EXIF segments across multiple scans', () => {
  const input = buildMultiScanJpeg();
  const snapshot = input.slice();
  const out = stripGps(input);

  assert.deepStrictEqual(input, snapshot); // input untouched
  assert.strictEqual(out.length, input.length);

  // Collect EXIF segments from the output; both must be GPS-free.
  const segs = [...iterateSegments(out)];
  const exifSegs = segs.filter((s) => s.marker === 0xe1 && out[s.payloadStart] === 0x45 && out[s.payloadStart + 1] === 0x78);
  assert.strictEqual(exifSegs.length, 2);
  for (const seg of exifSegs) {
    const base = seg.payloadStart + 6;
    // GPS directory table zeroed.
    assert.deepStrictEqual(
      [...out.subarray(base + GPS_IFD_OFF, base + GPS_IFD_OFF + 2 + 2 * 12 + 4)],
      new Array(2 + 2 * 12 + 4).fill(0),
    );
    // GPS-only external value zeroed.
    assert.deepStrictEqual(
      [...out.subarray(base + GPS_VAL_OFF, base + GPS_VAL_OFF + GPS_VAL_LEN)],
      new Array(GPS_VAL_LEN).fill(0),
    );
    // IFD0 has only the normal tag left.
    const le = out[base] === 0x49;
    const count = le ? out[base + 8] | (out[base + 9] << 8) : (out[base + 8] << 8) | out[base + 9];
    assert.strictEqual(count, 1);
    const tag = le ? out[base + 10] | (out[base + 11] << 8) : (out[base + 10] << 8) | out[base + 11];
    assert.ok(tag === 0x010f || tag === 0x0110);
  }

  // Everything outside the two EXIF TIFF payloads is byte-identical.
  const exifRanges = exifSegs.map((s) => [s.payloadStart + 6, s.payloadEnd] as const);
  for (let i = 0; i < out.length; i++) {
    if (exifRanges.some(([a, b]) => i >= a && i < b)) continue;
    assert.strictEqual(out[i], input[i], `byte ${i} outside EXIF changed`);
  }

  // Scan data (with escapes/restarts/fill) preserved exactly.
  const sosSegs = segs.filter((s) => s.marker === 0xda);
  assert.strictEqual(sosSegs.length, 2);
  assert.deepStrictEqual([...out.subarray(sosSegs[0].end, sosSegs[0].end + SCAN1.length)], SCAN1);
  assert.deepStrictEqual([...out.subarray(out.length - 2 - SCAN2.length, out.length - 2)], SCAN2);

  // Non-EXIF APP1 preserved.
  const nonExif = segs.find((s) => s.marker === 0xe1 && out[s.payloadStart] !== 0x45);
  assert.ok(nonExif);
  assert.deepStrictEqual([...out.subarray(nonExif!.payloadStart, nonExif!.payloadEnd)], APP1_NON_EXIF);

  // Idempotent.
  assert.deepStrictEqual(stripGps(out), out);
});

test('GPS bytes leave no recoverable residue', () => {
  const input = buildMultiScanJpeg();
  const out = stripGps(input);
  // The GPS latitude fill pattern 0x30..0x3f appears only in GPS values.
  for (let i = 0; i + 4 <= out.length; i++) {
    if (out[i] === 0x30 && out[i + 1] === 0x31 && out[i + 2] === 0x32 && out[i + 3] === 0x33) {
      assert.fail(`GPS value residue found at offset ${i}`);
    }
  }
});
