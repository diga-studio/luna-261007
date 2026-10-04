// Independent MVT 2.1 decoder used only by tests.

export interface DecodedFeature {
  id: number;
  type: number;
  rings: [number, number][][];
}

export interface DecodedLayer {
  name: string;
  version: number;
  extent: number;
  features: DecodedFeature[];
}

class Reader {
  pos = 0;
  constructor(private buf: Uint8Array) {}

  get done(): boolean {
    return this.pos >= this.buf.length;
  }

  varint(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = this.buf[this.pos++];
      result += (b & 0x7f) * Math.pow(2, shift);
      if ((b & 0x80) === 0) return result;
      shift += 7;
    }
  }

  tag(): { field: number; wire: number } {
    const v = this.varint();
    return { field: v >> 3, wire: v & 7 };
  }

  bytes(): Uint8Array {
    const len = this.varint();
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }

  skip(wire: number): void {
    if (wire === 0) this.varint();
    else if (wire === 2) this.bytes();
    else if (wire === 1) this.pos += 8;
    else if (wire === 5) this.pos += 4;
    else throw new Error(`unsupported wire type ${wire}`);
  }
}

function zigzagDecode(n: number): number {
  return (n >> 1) ^ -(n & 1);
}

function decodeGeometry(geom: number[]): [number, number][][] {
  const rings: [number, number][][] = [];
  let ring: [number, number][] | null = null;
  let x = 0;
  let y = 0;
  let i = 0;
  while (i < geom.length) {
    const cmdInt = geom[i++];
    const id = cmdInt & 7;
    const count = cmdInt >> 3;
    if (id === 1 || id === 2) {
      for (let k = 0; k < count; k++) {
        x += zigzagDecode(geom[i++]);
        y += zigzagDecode(geom[i++]);
        if (id === 1) {
          ring = [[x, y]];
          rings.push(ring);
        } else {
          if (!ring) throw new Error('LineTo without MoveTo');
          ring.push([x, y]);
        }
      }
    } else if (id === 7) {
      ring = null;
    } else {
      throw new Error(`unsupported command ${id}`);
    }
  }
  return rings;
}

function decodeFeature(buf: Uint8Array): DecodedFeature {
  const r = new Reader(buf);
  let id = 0;
  let type = 0;
  let geom: number[] = [];
  while (!r.done) {
    const { field, wire } = r.tag();
    if (field === 1) id = r.varint();
    else if (field === 2) r.skip(wire);
    else if (field === 3) type = r.varint();
    else if (field === 4) {
      if (wire === 2) {
        const packed = new Reader(r.bytes());
        geom = [];
        while (!packed.done) geom.push(packed.varint());
      } else {
        geom.push(r.varint());
      }
    } else r.skip(wire);
  }
  return { id, type, rings: decodeGeometry(geom) };
}

function decodeLayer(buf: Uint8Array): DecodedLayer {
  const r = new Reader(buf);
  let name = '';
  let version = 0;
  let extent = 4096;
  const features: DecodedFeature[] = [];
  while (!r.done) {
    const { field, wire } = r.tag();
    if (field === 15) version = r.varint();
    else if (field === 1) name = Buffer.from(r.bytes()).toString('utf8');
    else if (field === 2) features.push(decodeFeature(r.bytes()));
    else if (field === 5) extent = r.varint();
    else r.skip(wire);
  }
  return { name, version, extent, features };
}

export function decodeMvt(data: Uint8Array): DecodedLayer[] {
  const r = new Reader(data);
  const layers: DecodedLayer[] = [];
  while (!r.done) {
    const { field, wire } = r.tag();
    if (field === 3) layers.push(decodeLayer(r.bytes()));
    else r.skip(wire);
  }
  return layers;
}
