/** Minimal MVT 2.1 decoder + geometry helpers used by the tests. */

export type Point = [number, number];

export interface DecodedFeature {
  id: number;
  type: number;
  /** Rings in tile-local coords, closing point not duplicated. */
  rings: Point[][];
}

export interface DecodedLayer {
  name: string;
  version: string;
  extent: number;
  features: DecodedFeature[];
}

class Reader {
  pos = 0;
  private readonly data: Uint8Array;
  constructor(data: Uint8Array) {
    this.data = data;
  }

  get done(): boolean {
    return this.pos >= this.data.length;
  }

  varint(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = this.data[this.pos++];
      if (b === undefined) throw new Error('truncated varint');
      result += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) return result;
      shift += 7;
      if (shift > 56) throw new Error('varint too long');
    }
  }

  tag(): { field: number; wire: number } {
    const v = this.varint();
    return { field: v >> 3, wire: v & 7 };
  }

  bytes(): Uint8Array {
    const len = this.varint();
    const out = this.data.subarray(this.pos, this.pos + len);
    if (out.length !== len) throw new Error('truncated bytes');
    this.pos += len;
    return out;
  }

  skip(wire: number): void {
    if (wire === 0) this.varint();
    else if (wire === 2) this.bytes();
    else if (wire === 5) this.pos += 4;
    else if (wire === 1) this.pos += 8;
    else throw new Error(`unsupported wire type ${wire}`);
  }
}

function unzigzag(v: number): number {
  return v % 2 === 0 ? v / 2 : -(v + 1) / 2;
}

function decodeGeometry(data: Uint8Array): Point[][] {
  const reader = new Reader(data);
  const rings: Point[][] = [];
  let current: Point[] | null = null;
  let x = 0;
  let y = 0;
  while (!reader.done) {
    const cmdWord = reader.varint();
    const id = cmdWord & 7;
    const count = cmdWord >> 3;
    if (id === 1) {
      // MoveTo
      for (let i = 0; i < count; i++) {
        x += unzigzag(reader.varint());
        y += unzigzag(reader.varint());
        current = [[x, y]];
        rings.push(current);
      }
    } else if (id === 2) {
      // LineTo
      if (!current) throw new Error('LineTo without MoveTo');
      for (let i = 0; i < count; i++) {
        x += unzigzag(reader.varint());
        y += unzigzag(reader.varint());
        current.push([x, y]);
      }
    } else if (id === 7) {
      // ClosePath: nothing to read
    } else {
      throw new Error(`unknown command ${id}`);
    }
  }
  return rings;
}

function decodeFeature(data: Uint8Array): DecodedFeature {
  const reader = new Reader(data);
  let id = 0;
  let type = 0;
  let rings: Point[][] = [];
  while (!reader.done) {
    const { field, wire } = reader.tag();
    if (field === 1) id = reader.varint();
    else if (field === 3) type = reader.varint();
    else if (field === 4) rings = decodeGeometry(reader.bytes());
    else reader.skip(wire);
  }
  return { id, type, rings };
}

function decodeLayer(data: Uint8Array): DecodedLayer {
  const reader = new Reader(data);
  let name = '';
  let version = '';
  let extent = 4096;
  const features: DecodedFeature[] = [];
  while (!reader.done) {
    const { field, wire } = reader.tag();
    if (field === 1) name = new TextDecoder().decode(reader.bytes());
    else if (field === 2) features.push(decodeFeature(reader.bytes()));
    else if (field === 5) extent = reader.varint();
    else if (field === 15) version = new TextDecoder().decode(reader.bytes());
    else reader.skip(wire);
  }
  return { name, version, extent, features };
}

export function decodeTile(data: Uint8Array): DecodedLayer[] {
  const reader = new Reader(data);
  const layers: DecodedLayer[] = [];
  while (!reader.done) {
    const { field, wire } = reader.tag();
    if (field === 3) layers.push(decodeLayer(reader.bytes()));
    else reader.skip(wire);
  }
  return layers;
}

/** Twice the signed area; positive = clockwise in y-down coordinates. */
export function signedArea2(ring: Point[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i]!;
    const [x2, y2] = ring[(i + 1) % ring.length]!;
    sum += x1 * y2 - x2 * y1;
  }
  return sum;
}

/** Total covered area of a feature (exterior rings minus holes). */
export function coveredArea(feature: DecodedFeature): number {
  let total = 0;
  for (const ring of feature.rings) total += signedArea2(ring);
  return total / 2;
}

/** Even-odd containment across all rings of a feature. */
export function coversPoint(feature: DecodedFeature, px: number, py: number): boolean {
  let inside = false;
  for (const ring of feature.rings) {
    for (let i = 0; i < ring.length; i++) {
      const [x1, y1] = ring[i]!;
      const [x2, y2] = ring[(i + 1) % ring.length]!;
      if (y1 > py !== y2 > py) {
        const xCross = x1 + ((py - y1) * (x2 - x1)) / (y2 - y1);
        if (px < xCross) inside = !inside;
      }
    }
  }
  return inside;
}

/** True when no vertex repeats within the ring (closure excluded). */
export function isSimpleRing(ring: Point[]): boolean {
  const seen = new Set<string>();
  for (const [x, y] of ring) {
    const key = `${x},${y}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}
