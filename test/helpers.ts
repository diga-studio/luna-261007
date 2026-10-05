import { createHash } from 'node:crypto';
import { TextEncoder } from 'node:util';
import { StlAnalyzer, type StlMetadata } from '../src/index.js';

/** mulberry32：固定种子 PRNG，用于可复现的随机切块。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 三种切块方式：整块、单字节、固定种子随机切块。 */
export function* chunkings(data: Uint8Array): Generator<{ name: string; chunks: Uint8Array[] }> {
  yield { name: 'whole', chunks: [data] };
  const singles: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += 1) singles.push(data.subarray(i, i + 1));
  yield { name: 'bytewise', chunks: singles };
  const rand = mulberry32(0x5eed);
  const random: Uint8Array[] = [];
  let pos = 0;
  while (pos < data.length) {
    const n = 1 + Math.floor(rand() * 97);
    random.push(data.subarray(pos, Math.min(pos + n, data.length)));
    pos += n;
  }
  yield { name: 'random', chunks: random };
}

export function analyze(chunks: Iterable<Uint8Array>): StlMetadata {
  const analyzer = new StlAnalyzer();
  for (const c of chunks) analyzer.push(c);
  return analyzer.finish();
}

export function analyzeError(chunks: Iterable<Uint8Array>): Error {
  const analyzer = new StlAnalyzer();
  try {
    for (const c of chunks) analyzer.push(c);
    analyzer.finish();
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected analysis to fail, but it succeeded');
}

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export interface Tri {
  normal: [number, number, number];
  vertices: [number, number, number][];
}

export function makeTri(vertices: [number, number, number][], normal: [number, number, number] = [0, 0, 1]): Tri {
  return { normal, vertices };
}

/** 构造二进制 STL 字节。 */
export function makeBinary(tris: Tri[], opts: { header?: string; declaredCount?: number; trailing?: Uint8Array } = {}): Uint8Array {
  const count = opts.declaredCount ?? tris.length;
  const body = new Uint8Array(84 + tris.length * 50 + (opts.trailing?.length ?? 0));
  if (opts.header) {
    const h = encode(opts.header);
    body.set(h.subarray(0, 80), 0);
  }
  const view = new DataView(body.buffer);
  view.setUint32(80, count, true);
  tris.forEach((tri, i) => {
    const base = 84 + i * 50;
    const comps = [...tri.normal, ...tri.vertices[0]!, ...tri.vertices[1]!, ...tri.vertices[2]!];
    comps.forEach((v, j) => view.setFloat32(base + j * 4, v, true));
    view.setUint16(base + 48, 7, true); // 属性任意
  });
  if (opts.trailing) body.set(opts.trailing, 84 + tris.length * 50);
  return body;
}

/** 构造 ASCII STL 文本。 */
export function makeAscii(solids: { name?: string; facets: Tri[] }[], opts: { finalNewline?: boolean } = {}): string {
  const parts: string[] = [];
  for (const s of solids) {
    parts.push(`solid${s.name !== undefined ? ' ' + s.name : ''}\n`);
    for (const f of s.facets) {
      parts.push(`facet normal ${f.normal.join(' ')}\nouter loop\n`);
      for (const v of f.vertices) parts.push(`vertex ${v.join(' ')}\n`);
      parts.push('endloop\nendfacet\n');
    }
    parts.push(`endsolid${s.name !== undefined ? ' ' + s.name : ''}`);
    parts.push('\n');
  }
  let out = parts.join('');
  if (opts.finalNewline === false && out.endsWith('\n')) out = out.slice(0, -1);
  return out;
}

export interface BboxExpect {
  min: [number, number, number];
  max: [number, number, number];
}

/** 由三角形集合计算期望英寸包围盒（顶点 mm / 25.4）。 */
export function expectBbox(tris: Tri[], opts: { float32?: boolean } = {}): BboxExpect | null {
  if (tris.length === 0) return null;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const t of tris) {
    for (const v of t.vertices) {
      for (let a = 0; a < 3; a += 1) {
        // 二进制 STL 按 Float32 存储，期望值需做同样舍入
        const x = opts.float32 ? Math.fround(v[a]!) : v[a]!;
        if (x < min[a]!) min[a] = x;
        if (x > max[a]!) max[a] = x;
      }
    }
  }
  const div = (x: number) => x / 25.4;
  return {
    min: [div(min[0]!), div(min[1]!), div(min[2]!)],
    max: [div(max[0]!), div(max[1]!), div(max[2]!)],
  };
}
