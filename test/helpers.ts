import { StlAnalyzer } from "../src/index.js";
import type { AnalyzeResult } from "../src/index.js";

export interface Triangle {
  normal: [number, number, number];
  vertices: [
    [number, number, number],
    [number, number, number],
    [number, number, number],
  ];
  attr?: number;
}

/** Build a binary STL file. Header defaults to 80 zero bytes. */
export function buildBinaryStl(
  triangles: Triangle[],
  header?: Uint8Array,
  declaredCount?: number,
): Uint8Array {
  const head = new Uint8Array(80);
  if (header) head.set(header.subarray(0, 80));
  const out = new Uint8Array(84 + triangles.length * 50);
  out.set(head, 0);
  const view = new DataView(out.buffer);
  view.setUint32(80, declaredCount ?? triangles.length, true);
  triangles.forEach((tri, i) => {
    const base = 84 + i * 50;
    const comps = [...tri.normal, ...tri.vertices[0], ...tri.vertices[1], ...tri.vertices[2]];
    comps.forEach((c, j) => view.setFloat32(base + j * 4, c, true));
    view.setUint16(base + 48, tri.attr ?? 0, true);
  });
  return out;
}

/** Deterministic PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Split data into random chunks using a seeded PRNG. */
export function randomChunks(data: Uint8Array, seed: number): Uint8Array[] {
  const rand = mulberry32(seed);
  const chunks: Uint8Array[] = [];
  let offset = 0;
  while (offset < data.length) {
    const remaining = data.length - offset;
    const size = 1 + Math.floor(rand() * Math.min(remaining, 4096));
    chunks.push(data.subarray(offset, offset + size));
    offset += size;
  }
  return chunks;
}

export function singleBytes(data: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = new Array(data.length);
  for (let i = 0; i < data.length; i++) chunks[i] = data.subarray(i, i + 1);
  return chunks;
}

/** Run the analyzer over a sequence of chunks. */
export function analyze(chunks: Iterable<Uint8Array>): AnalyzeResult {
  const analyzer = new StlAnalyzer();
  for (const chunk of chunks) analyzer.push(chunk);
  return analyzer.finish();
}

/** All three chunkings of the same data. */
export function allChunkings(data: Uint8Array, seed = 12345): Uint8Array[][] {
  return [[data], singleBytes(data), randomChunks(data, seed)];
}
