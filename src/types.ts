/** A parsed JPEG segment: marker code plus the raw bytes covering
 *  the marker itself through the end of the segment (or scan data). */
export interface JpegSegment {
  /** Marker code byte, e.g. 0xe1 for APP1, 0xda for SOS. */
  marker: number;
  /** Start offset of the 0xff marker byte in the original input. */
  start: number;
  /** Offset one past the last byte belonging to this segment/scan. */
  end: number;
  /** Offset of the segment payload (after marker + length field). */
  dataStart: number;
  /** Offset one past the segment payload (before any scan data). */
  dataEnd: number;
}

/** TIFF data types 1..12 mapped to their byte sizes. */
export const TYPE_SIZES: readonly number[] = [
  0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8,
];

/** A single retained IFD entry (non-GPS). */
export interface IfdEntry {
  tag: number;
  type: number;
  count: number;
  /** Raw value bytes when the value is external (count*size > 4),
   *  otherwise the original 4 inline bytes. */
  valueBytes: Uint8Array;
  /** True when the value is stored inline in the 4-byte field. */
  inline: boolean;
  /** Set when this entry is a subdirectory pointer (0x8769 / 0xa005). */
  child?: IfdNode;
}

/** A retained IFD in the directory graph. */
export interface IfdNode {
  entries: IfdEntry[];
  /** Next IFD in the chain, if any. */
  next: IfdNode | null;
}
