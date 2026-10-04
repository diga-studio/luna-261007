import type { ClippedRing } from './types.ts';

export interface MvtFeature {
  id: number;
  rings: ClippedRing[];
}

const CMD_MOVE_TO = 1;
const CMD_LINE_TO = 2;
const CMD_CLOSE_PATH = 7;
const GEOM_TYPE_POLYGON = 3;

class ByteWriter {
  private chunks: number[] = [];

  get length(): number {
    return this.chunks.length;
  }

  byte(value: number): void {
    this.chunks.push(value & 0xff);
  }

  varint(value: number): void {
    let v = value;
    if (v < 0 || !Number.isSafeInteger(v)) {
      throw new Error(`invalid varint value: ${value}`);
    }
    while (v > 0x7f) {
      this.chunks.push((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    this.chunks.push(v);
  }

  bytes(data: Uint8Array): void {
    for (const b of data) this.chunks.push(b);
  }

  tag(field: number, wireType: number): void {
    this.varint((field << 3) | wireType);
  }

  uint64Field(field: number, value: number): void {
    this.tag(field, 0);
    this.varint(value);
  }

  bytesField(field: number, data: Uint8Array): void {
    this.tag(field, 2);
    this.varint(data.length);
    this.bytes(data);
  }

  stringField(field: number, value: string): void {
    this.bytesField(field, new TextEncoder().encode(value));
  }

  toUint8Array(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
}

function zigzag(value: number): number {
  return value >= 0 ? value * 2 : -value * 2 - 1;
}

function command(id: number, count: number): number {
  return (count << 3) | id;
}

/** Encodes the geometry of one polygon feature (MVT command stream). */
export function encodePolygonGeometry(rings: ClippedRing[]): Uint8Array {
  const out = new ByteWriter();
  let cursorX = 0;
  let cursorY = 0;
  for (const ring of rings) {
    const points = ring.points;
    if (points.length < 3) continue;
    out.varint(command(CMD_MOVE_TO, 1));
    const first = points[0]!;
    out.varint(zigzag(first[0] - cursorX));
    out.varint(zigzag(first[1] - cursorY));
    cursorX = first[0];
    cursorY = first[1];
    out.varint(command(CMD_LINE_TO, points.length - 1));
    for (let i = 1; i < points.length; i++) {
      const p = points[i]!;
      out.varint(zigzag(p[0] - cursorX));
      out.varint(zigzag(p[1] - cursorY));
      cursorX = p[0];
      cursorY = p[1];
    }
    out.varint(command(CMD_CLOSE_PATH, 1));
  }
  return out.toUint8Array();
}

function encodeFeature(feature: MvtFeature): Uint8Array {
  const out = new ByteWriter();
  out.uint64Field(1, feature.id); // id
  out.tag(2, 2); // tags: empty packed array
  out.varint(0);
  out.uint64Field(3, GEOM_TYPE_POLYGON); // type = POLYGON
  out.bytesField(4, encodePolygonGeometry(feature.rings)); // geometry
  return out.toUint8Array();
}

/** Encodes one tile (single layer) as an MVT 2.1 protobuf byte string. */
export function encodeTileMvt(features: MvtFeature[], extent: number): Uint8Array {
  const layer = new ByteWriter();
  layer.stringField(15, '2'); // version
  layer.stringField(1, 'terrasight'); // name
  for (const feature of features) {
    layer.bytesField(2, encodeFeature(feature));
  }
  layer.uint64Field(5, extent); // extent
  const tile = new ByteWriter();
  tile.bytesField(3, layer.toUint8Array());
  return tile.toUint8Array();
}
