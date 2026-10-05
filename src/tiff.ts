/** TIFF field type sizes in bytes (types 1..12). */
export const TYPE_SIZES: readonly number[] = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];

/** A parsed TIFF/EXIF directory (IFD). */
export interface Ifd {
  /** Offset of the entry count field within the TIFF data. */
  offset: number;
  /** Number of entries. */
  count: number;
  /** Offset of the next-IFD pointer field. */
  nextOffsetPos: number;
  /** Offset of the next IFD (0 = none). */
  next: number;
}

/** A parsed TIFF directory entry. */
export interface IfdEntry {
  tag: number;
  type: number;
  count: number;
  /** Offset of the entry record (12 bytes) within the TIFF data. */
  recordOffset: number;
  /** Offset of the value bytes (inline or external) within the TIFF data. */
  valueOffset: number;
  /** Total byte size of the value. */
  valueSize: number;
  /** True when the value is stored inline in the 4-byte value field. */
  inline: boolean;
}

/** Endian-aware reader over the TIFF payload. */
export interface TiffReader {
  littleEndian: boolean;
  u16(offset: number): number;
  u32(offset: number): number;
}

export function makeReader(_data: Uint8Array, _base: number): TiffReader {
  const data = _data;
  const base = _base;
  const littleEndian = data[base] === 0x49 && data[base + 1] === 0x49;
  return {
    littleEndian,
    u16(offset: number): number {
      const p = base + offset;
      return littleEndian
        ? data[p] | (data[p + 1] << 8)
        : (data[p] << 8) | data[p + 1];
    },
    u32(offset: number): number {
      const p = base + offset;
      return littleEndian
        ? (data[p] | (data[p + 1] << 8) | (data[p + 2] << 16) | (data[p + 3] << 24)) >>> 0
        : ((data[p] << 24) | (data[p + 1] << 16) | (data[p + 2] << 8) | data[p + 3]) >>> 0;
    },
  };
}

export function parseIfd(_reader: TiffReader, _offset: number): Ifd {
  const count = _reader.u16(_offset);
  const nextOffsetPos = _offset + 2 + count * 12;
  return {
    offset: _offset,
    count,
    nextOffsetPos,
    next: _reader.u32(nextOffsetPos),
  };
}

export function parseEntries(_reader: TiffReader, _ifd: Ifd): IfdEntry[] {
  const entries: IfdEntry[] = [];
  for (let i = 0; i < _ifd.count; i++) {
    const recordOffset = _ifd.offset + 2 + i * 12;
    const tag = _reader.u16(recordOffset);
    const type = _reader.u16(recordOffset + 2);
    const count = _reader.u32(recordOffset + 4);
    const typeSize = type >= 1 && type <= 12 ? TYPE_SIZES[type] : 0;
    const valueSize = typeSize * count;
    const inline = valueSize <= 4;
    const valueOffset = inline ? recordOffset + 8 : _reader.u32(recordOffset + 8);
    entries.push({ tag, type, count, recordOffset, valueOffset, valueSize, inline });
  }
  return entries;
}
