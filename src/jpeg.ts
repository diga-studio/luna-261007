/** A single JPEG segment: marker code plus the byte range it occupies. */
export interface JpegSegment {
  /** Marker code byte (e.g. 0xE1 for APP1). */
  marker: number;
  /** Offset of the 0xFF marker byte in the file. */
  start: number;
  /** Offset one past the end of the segment (including marker + length + payload). */
  end: number;
  /** Offset of the segment payload (after the 2-byte length field). -1 for markers without payload. */
  payloadStart: number;
  /** Offset one past the payload. -1 for markers without payload. */
  payloadEnd: number;
}

/**
 * Iterate over the marker segments of a JPEG file, correctly skipping
 * entropy-coded scan data (FF00 escapes, restart markers, 0xFF fill bytes).
 */
export function* iterateSegments(data: Uint8Array): Generator<JpegSegment> {
  const n = data.length;
  if (n < 2 || data[0] !== 0xff || data[1] !== 0xd8) {
    throw new Error('not a JPEG file: missing SOI marker');
  }
  yield { marker: 0xd8, start: 0, end: 2, payloadStart: -1, payloadEnd: -1 };

  let pos = 2;
  while (pos < n) {
    if (data[pos] !== 0xff) {
      throw new Error(`corrupt JPEG: expected marker at offset ${pos}`);
    }
    const start = pos;
    // Skip 0xFF fill bytes preceding the marker code.
    while (pos < n && data[pos] === 0xff) pos++;
    if (pos >= n) return;
    const marker = data[pos];
    pos++;
    if (marker === 0x00) {
      throw new Error(`corrupt JPEG: stuffed byte at segment boundary (offset ${start})`);
    }

    // Standalone markers without a length field.
    if (
      marker === 0xd8 || // SOI
      marker === 0xd9 || // EOI
      marker === 0x01 || // TEM
      (marker >= 0xd0 && marker <= 0xd7) // RSTn
    ) {
      yield { marker, start, end: pos, payloadStart: -1, payloadEnd: -1 };
      if (marker === 0xd9) return;
      continue;
    }

    if (pos + 2 > n) {
      throw new Error('corrupt JPEG: truncated segment length');
    }
    const len = (data[pos] << 8) | data[pos + 1];
    if (len < 2) {
      throw new Error(`corrupt JPEG: invalid segment length ${len} at offset ${start}`);
    }
    const payloadStart = pos + 2;
    const payloadEnd = pos + len;
    if (payloadEnd > n) {
      throw new Error('corrupt JPEG: segment extends past end of data');
    }
    yield { marker, start, end: payloadEnd, payloadStart, payloadEnd };
    pos = payloadEnd;

    if (marker === 0xda) {
      // SOS: entropy-coded scan data follows until the next real marker.
      // FF00 = escaped 0xFF, FFD0-D7 = restart, FF01 = TEM, runs of FF = fill.
      while (pos < n) {
        if (data[pos] !== 0xff) {
          pos++;
          continue;
        }
        let q = pos + 1;
        while (q < n && data[q] === 0xff) q++;
        if (q >= n) {
          pos = n;
          break;
        }
        const b = data[q];
        if (b === 0x00 || (b >= 0xd0 && b <= 0xd7) || b === 0x01) {
          pos = q + 1;
          continue;
        }
        break; // real marker; fill FFs belong to the next segment
      }
    }
  }
}
