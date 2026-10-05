import type { JpegSegment } from "./types";

/** Split a JPEG byte stream into its marker segments, correctly
 *  skipping entropy-coded scan data (FF00 escapes, restart markers
 *  and 0xff padding are not treated as segment boundaries). */
export function parseJpegSegments(input: Uint8Array): JpegSegment[] {
  if (input.length < 2 || input[0] !== 0xff || input[1] !== 0xd8) {
    throw new Error("not a JPEG stream: missing SOI marker");
  }
  const segments: JpegSegment[] = [];
  let pos = 2;
  while (pos < input.length) {
    if (input[pos] !== 0xff) break; // trailing bytes after EOI
    const start = pos;
    while (pos < input.length && input[pos] === 0xff) pos++;
    if (pos >= input.length) break;
    const marker = input[pos];
    pos++;
    if (marker === 0x00) throw new Error(`stuffed byte outside scan at ${pos}`);
    // Standalone markers without a length field: TEM, RSTn, SOI, EOI.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      segments.push({ marker, start, end: pos, dataStart: pos, dataEnd: pos });
      continue;
    }
    if (pos + 2 > input.length) throw new Error("truncated segment length");
    const length = (input[pos] << 8) | input[pos + 1];
    if (length < 2 || pos + length > input.length) {
      throw new Error("invalid segment length");
    }
    const dataStart = pos + 2;
    const dataEnd = pos + length;
    pos = dataEnd;
    if (marker === 0xda) {
      // SOS: entropy-coded data runs until the next real marker.
      // FF00 is an escaped data byte, FFD0-FFD7 are restart markers
      // and runs of FFFF are padding: none of them start a segment.
      while (pos < input.length) {
        if (input[pos] === 0xff && pos + 1 < input.length) {
          const next = input[pos + 1];
          if (next === 0x00) {
            pos += 2;
            continue;
          }
          if (next === 0xff) {
            pos += 1;
            continue;
          }
          if (next >= 0xd0 && next <= 0xd7) {
            pos += 2;
            continue;
          }
          break; // real marker: ends the scan
        }
        pos++;
      }
    }
    segments.push({ marker, start, end: pos, dataStart, dataEnd });
  }
  return segments;
}
