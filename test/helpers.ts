/** Test helpers: byte-level TIFF/JPEG builders and an independent
 *  TIFF reader used to verify the library output. */

export class Writer {
  readonly little: boolean;
  private bytes: number[] = [];

  constructor(little: boolean) {
    this.little = little;
  }

  get offset(): number {
    return this.bytes.length;
  }

  u16(v: number): void {
    if (this.little) {
      this.bytes.push(v & 0xff, (v >> 8) & 0xff);
    } else {
      this.bytes.push((v >> 8) & 0xff, v & 0xff);
    }
  }

  u32(v: number): void {
    if (this.little) {
      this.bytes.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
    } else {
      this.bytes.push((v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
    }
  }

  raw(values: ArrayLike<number>): void {
    for (let i = 0; i < values.length; i++) this.bytes.push(values[i] & 0xff);
  }

  patch32(at: number, v: number): void {
    if (this.little) {
      this.bytes[at] = v & 0xff;
      this.bytes[at + 1] = (v >> 8) & 0xff;
      this.bytes[at + 2] = (v >> 16) & 0xff;
      this.bytes[at + 3] = (v >> 24) & 0xff;
    } else {
      this.bytes[at] = (v >> 24) & 0xff;
      this.bytes[at + 1] = (v >> 16) & 0xff;
      this.bytes[at + 2] = (v >> 8) & 0xff;
      this.bytes[at + 3] = v & 0xff;
    }
  }

  toBytes(): Uint8Array {
    return new Uint8Array(this.bytes);
  }
}

/** Pack up to 4 inline value bytes into the 4-byte value field. */
export function packInline(little: boolean, bytes: ArrayLike<number>): number {
  const b = [0, 0, 0, 0];
  for (let i = 0; i < bytes.length && i < 4; i++) b[i] = bytes[i];
  return little
    ? ((b[3] << 24) | (b[2] << 16) | (b[1] << 8) | b[0]) >>> 0
    : ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
}

export function writeTiffHeader(w: Writer): void {
  w.raw(w.little ? [0x49, 0x49] : [0x4d, 0x4d]);
  w.u16(42);
  w.u32(8);
}

/** Write one 12-byte IFD entry. valueField is the raw 4-byte field
 *  (inline value or offset). Returns the offset of the value field
 *  for later patching. */
export function ifdEntry(
  w: Writer,
  tag: number,
  type: number,
  count: number,
  valueField: number,
): number {
  w.u16(tag);
  w.u16(type);
  w.u32(count);
  const at = w.offset;
  w.u32(valueField);
  return at;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

/** Wrap a TIFF payload into an APP1 EXIF segment (marker + length). */
export function exifSegment(tiff: Uint8Array): Uint8Array {
  const header = new Uint8Array([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]);
  const payload = concat(header, tiff);
  const seg = new Uint8Array(4 + payload.length);
  seg[0] = 0xff;
  seg[1] = 0xe1;
  const len = payload.length + 2;
  seg[2] = (len >> 8) & 0xff;
  seg[3] = len & 0xff;
  seg.set(payload, 4);
  return seg;
}

/** Build a generic JPEG segment with a length field. */
export function segment(marker: number, payload: Uint8Array): Uint8Array {
  const seg = new Uint8Array(4 + payload.length);
  seg[0] = 0xff;
  seg[1] = marker;
  const len = payload.length + 2;
  seg[2] = (len >> 8) & 0xff;
  seg[3] = len & 0xff;
  seg.set(payload, 4);
  return seg;
}

// ---- independent reader used for verification ----

export function readU16(buf: Uint8Array, off: number, little: boolean): number {
  return little ? buf[off] | (buf[off + 1] << 8) : (buf[off] << 8) | buf[off + 1];
}

export function readU32(buf: Uint8Array, off: number, little: boolean): number {
  return little
    ? (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0
    : ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
}

export interface ReadEntry {
  tag: number;
  type: number;
  count: number;
  /** Raw 4-byte value field. */
  field: Uint8Array;
  /** Field interpreted as an offset. */
  offset: number;
}

export interface ReadIfd {
  entries: ReadEntry[];
  nextOffset: number;
}

export function readIfd(tiff: Uint8Array, little: boolean, offset: number): ReadIfd {
  const count = readU16(tiff, offset, little);
  const entries: ReadEntry[] = [];
  for (let i = 0; i < count; i++) {
    const eoff = offset + 2 + i * 12;
    entries.push({
      tag: readU16(tiff, eoff, little),
      type: readU16(tiff, eoff + 2, little),
      count: readU32(tiff, eoff + 4, little),
      field: tiff.slice(eoff + 8, eoff + 12),
      offset: readU32(tiff, eoff + 8, little),
    });
  }
  return {
    entries,
    nextOffset: readU32(tiff, offset + 2 + count * 12, little),
  };
}

/** True when `needle` occurs in `haystack`. */
export function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}
