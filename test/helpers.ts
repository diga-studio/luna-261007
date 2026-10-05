/** Test helpers: hand-crafted TIFF/EXIF and JPEG byte construction. */

export interface EntrySpec {
  tag: number;
  type: number;
  count: number;
  /** Inline value bytes (padded/truncated to 4). Exactly one of inline/external. */
  inline?: number[];
  /** Offset of the external value within the TIFF data. */
  external?: number;
}

/** Low-level TIFF image builder with explicit offset control. */
export class TiffBuilder {
  private buf: Uint8Array;
  private le: boolean;
  private used = 8;

  constructor(littleEndian: boolean, size = 4096) {
    this.buf = new Uint8Array(size);
    this.le = littleEndian;
    this.buf[0] = littleEndian ? 0x49 : 0x4d;
    this.buf[1] = littleEndian ? 0x49 : 0x4d;
    this.w16(2, 42);
    this.w32(4, 8); // default IFD0 offset; override with setIfd0Offset
  }

  private touch(end: number): void {
    this.used = Math.max(this.used, end);
  }

  w16(offset: number, value: number): void {
    if (this.le) {
      this.buf[offset] = value & 0xff;
      this.buf[offset + 1] = (value >>> 8) & 0xff;
    } else {
      this.buf[offset] = (value >>> 8) & 0xff;
      this.buf[offset + 1] = value & 0xff;
    }
    this.touch(offset + 2);
  }

  w32(offset: number, value: number): void {
    if (this.le) {
      this.buf[offset] = value & 0xff;
      this.buf[offset + 1] = (value >>> 8) & 0xff;
      this.buf[offset + 2] = (value >>> 16) & 0xff;
      this.buf[offset + 3] = (value >>> 24) & 0xff;
    } else {
      this.buf[offset] = (value >>> 24) & 0xff;
      this.buf[offset + 1] = (value >>> 16) & 0xff;
      this.buf[offset + 2] = (value >>> 8) & 0xff;
      this.buf[offset + 3] = value & 0xff;
    }
    this.touch(offset + 4);
  }

  setIfd0Offset(offset: number): void {
    this.w32(4, offset);
  }

  raw(offset: number, bytes: ArrayLike<number>): void {
    this.buf.set(bytes, offset);
    this.touch(offset + bytes.length);
  }

  ifd(offset: number, entries: EntrySpec[], next = 0): void {
    this.w16(offset, entries.length);
    entries.forEach((entry, i) => {
      const rec = offset + 2 + i * 12;
      this.w16(rec, entry.tag);
      this.w16(rec + 2, entry.type);
      this.w32(rec + 4, entry.count);
      if (entry.inline !== undefined) {
        const bytes = [...entry.inline];
        while (bytes.length < 4) bytes.push(0);
        this.raw(rec + 8, bytes.slice(0, 4));
      } else {
        this.w32(rec + 8, entry.external as number);
      }
    });
    this.w32(offset + 2 + entries.length * 12, next);
  }

  bytes(): Uint8Array {
    return this.buf.slice(0, this.used);
  }
}

export function concat(...parts: Array<ArrayLike<number>>): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p as Uint8Array, pos);
    pos += p.length;
  }
  return out;
}

/** A JPEG segment with a length field: FF marker len payload. */
export function segment(marker: number, payload: ArrayLike<number>): Uint8Array {
  const len = payload.length + 2;
  return concat([0xff, marker, (len >> 8) & 0xff, len & 0xff], payload);
}

export function exifSegment(tiff: Uint8Array): Uint8Array {
  return segment(0xe1, concat([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], tiff));
}

/** Assemble a JPEG file from parts placed between SOI and EOI. */
export function jpeg(...parts: Array<ArrayLike<number>>): Uint8Array {
  return concat([0xff, 0xd8], ...parts, [0xff, 0xd9]);
}
