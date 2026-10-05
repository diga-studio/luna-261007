import { parseJpegSegments } from "./jpeg";
import { stripGpsFromTiff } from "./tiff";

const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"

function isExifPayload(input: Uint8Array, start: number, end: number): boolean {
  if (end - start < EXIF_HEADER.length) return false;
  return EXIF_HEADER.every((b, i) => input[start + i] === b);
}

/**
 * Return an independent copy of the given JPEG bytes with every EXIF
 * GPS directory removed. The input is never modified. When the image
 * contains no GPS data the returned bytes are identical to the input.
 */
export function stripGps(input: Uint8Array): Uint8Array {
  const segments = parseJpegSegments(input);
  const rebuilt = new Map<number, Uint8Array>();
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.marker !== 0xe1) continue;
    if (!isExifPayload(input, seg.dataStart, seg.dataEnd)) continue;
    const tiff = input.subarray(seg.dataStart + EXIF_HEADER.length, seg.dataEnd);
    const result = stripGpsFromTiff(tiff);
    if (!result.changed || !result.bytes) continue;
    const payload = result.bytes;
    const out = new Uint8Array(4 + EXIF_HEADER.length + payload.length);
    out[0] = 0xff;
    out[1] = 0xe1;
    const length = out.length - 2;
    out[2] = (length >> 8) & 0xff;
    out[3] = length & 0xff;
    out.set(EXIF_HEADER, 4);
    out.set(payload, 4 + EXIF_HEADER.length);
    rebuilt.set(i, out);
  }
  if (rebuilt.size === 0) return input.slice();

  let total = 2; // SOI
  for (let i = 0; i < segments.length; i++) {
    total += rebuilt.get(i)?.length ?? segments[i].end - segments[i].start;
  }
  const lastEnd = segments.length > 0 ? segments[segments.length - 1].end : 2;
  total += input.length - lastEnd; // trailing bytes after the last segment

  const out = new Uint8Array(total);
  let pos = 0;
  out.set(input.subarray(0, 2), pos);
  pos += 2;
  for (let i = 0; i < segments.length; i++) {
    const replacement = rebuilt.get(i);
    if (replacement) {
      out.set(replacement, pos);
      pos += replacement.length;
    } else {
      out.set(input.subarray(segments[i].start, segments[i].end), pos);
      pos += segments[i].end - segments[i].start;
    }
  }
  out.set(input.subarray(lastEnd), pos);
  return out;
}
