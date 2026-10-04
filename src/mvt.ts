import { LinearRing } from './types';

export interface MvtPolygonFeature {
  id: number;
  /** Clockwise outer rings (y-down, tile-local). */
  outers: LinearRing[];
  /** Counterclockwise hole rings (y-down, tile-local). */
  holes: LinearRing[];
}

class Writer {
  private buf: number[] = [];

  varint(value: number): void {
    let v = value >>> 0;
    if (v === value) {
      while (v > 0x7f) {
        this.buf.push((v & 0x7f) | 0x80);
        v >>>= 7;
      }
      this.buf.push(v);
      return;
    }
    // Large integers (ids above 2^32): encode via safe-integer arithmetic.
    let rest = value;
    while (rest > 0x7f) {
      this.buf.push((rest % 128) | 0x80);
      rest = Math.floor(rest / 128);
    }
    this.buf.push(rest);
  }

  tag(field: number, wireType: number): void {
    this.varint((field << 3) | wireType);
  }

  bytes(data: Uint8Array): void {
    for (let i = 0; i < data.length; i++) this.buf.push(data[i]);
  }

  message(field: number, body: Uint8Array): void {
    this.tag(field, 2);
    this.varint(body.length);
    this.bytes(body);
  }

  str(field: number, value: string): void {
    this.message(field, encodeUtf8(value));
  }

  uint(field: number, value: number): void {
    this.tag(field, 0);
    this.varint(value);
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.buf);
  }
}

function encodeUtf8(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let cp = s.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < s.length) {
      const lo = s.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      }
    }
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return Uint8Array.from(out);
}

function zigzag(n: number): number {
  return (n << 1) ^ (n >> 31);
}

const CMD_MOVE_TO = 1;
const CMD_LINE_TO = 2;
const CMD_CLOSE_PATH = 7;
const GEOM_POLYGON = 3;

function commandInteger(id: number, count: number): number {
  return (id & 0x7) | (count << 3);
}

/** Encode one feature's geometry field (packed uint32 command stream). */
function encodeGeometry(f: MvtPolygonFeature): number[] {
  const out: number[] = [];
  let cx = 0;
  let cy = 0;
  const rings = f.outers.concat(f.holes);
  for (const ring of rings) {
    out.push(commandInteger(CMD_MOVE_TO, 1));
    out.push(zigzag(ring[0][0] - cx), zigzag(ring[0][1] - cy));
    cx = ring[0][0];
    cy = ring[0][1];
    out.push(commandInteger(CMD_LINE_TO, ring.length - 1));
    for (let i = 1; i < ring.length; i++) {
      out.push(zigzag(ring[i][0] - cx), zigzag(ring[i][1] - cy));
      cx = ring[i][0];
      cy = ring[i][1];
    }
    out.push(commandInteger(CMD_CLOSE_PATH, 1));
  }
  return out;
}

function encodeFeature(f: MvtPolygonFeature): Uint8Array {
  const w = new Writer();
  w.uint(1, f.id);
  w.uint(3, GEOM_POLYGON);
  const geom = encodeGeometry(f);
  const packed = new Writer();
  for (const g of geom) packed.varint(g);
  w.message(4, packed.finish());
  return w.finish();
}

/** Encode features as a single-layer MVT 2.1 tile. */
export function encodeMvt(
  features: MvtPolygonFeature[],
  extent: number,
  layerName: string,
): Uint8Array {
  const layer = new Writer();
  layer.uint(15, 2); // version
  layer.str(1, layerName);
  for (const f of features) layer.message(2, encodeFeature(f));
  layer.uint(5, extent);

  const tile = new Writer();
  tile.message(3, layer.finish());
  return tile.finish();
}
