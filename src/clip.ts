import type { ClippedRing, MultiPolygonCoordinates, Position } from './types.ts';

interface GridEdge {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  used: boolean;
}

function vertexKey(x: number, y: number): string {
  return `${x},${y}`;
}

/** Even-odd point-in-polygon over all rings. Point given in doubled coords. */
function pointInRings(rings: Position[][], px2: number, py2: number): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % ring.length]!;
      if (a[0] !== b[0]) continue; // only vertical edges cross a horizontal ray
      const y1 = a[1] * 2;
      const y2 = b[1] * 2;
      if (y1 > py2 !== y2 > py2 && px2 < a[0] * 2) {
        inside = !inside;
      }
    }
  }
  return inside;
}

/** Even-odd point-in-single-ring. Ring coords and point in doubled coords. */
function pointInRing(ring: Position[], px2: number, py2: number): boolean {
  let inside = false;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    if (a[0] !== b[0]) continue;
    const y1 = a[1] * 2;
    const y2 = b[1] * 2;
    if (y1 > py2 !== y2 > py2 && px2 < a[0] * 2) {
      inside = !inside;
    }
  }
  return inside;
}

function signedArea2(points: Position[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum;
}

/** Removes collinear consecutive vertices (including wrap-around). */
function simplify(points: Position[]): Position[] {
  const out: Position[] = [];
  for (let i = 0; i < points.length; i++) {
    const prev = out.length > 0 ? out[out.length - 1]! : points[(i - 1 + points.length) % points.length]!;
    const cur = points[i]!;
    const next = points[(i + 1) % points.length]!;
    const d1x = cur[0] - prev[0];
    const d1y = cur[1] - prev[1];
    const d2x = next[0] - cur[0];
    const d2y = next[1] - cur[1];
    if (d1x * d2y - d1y * d2x === 0) continue;
    out.push(cur);
  }
  // Re-check the seam: first points may be collinear with last ones.
  while (out.length >= 3) {
    const n = out.length;
    const prev = out[n - 1]!;
    const cur = out[0]!;
    const next = out[1]!;
    const d1x = cur[0] - prev[0];
    const d1y = cur[1] - prev[1];
    const d2x = next[0] - cur[0];
    const d2y = next[1] - cur[1];
    if (d1x * d2y - d1y * d2x !== 0) break;
    out.shift();
  }
  return out;
}

/**
 * Intersects a feature (MultiPolygon coordinates in global integer coords)
 * with the tile rectangle [origin, origin+extent)^2. Returns simple rings in
 * tile-local coordinates. The intersection is computed exactly by classifying
 * cells of the arrangement of all input edge lines against the (rectilinear)
 * input, so holes, splits and notches are preserved.
 */
export function clipToTile(
  geometry: MultiPolygonCoordinates,
  originX: number,
  originY: number,
  extent: number,
): ClippedRing[] {
  const rings: Position[][] = [];
  for (const polygon of geometry) {
    for (const ring of polygon) {
      const local: Position[] = [];
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i]!;
        const q = ring[(i + 1) % ring.length]!;
        if (p[0] === q[0] && p[1] === q[1]) continue; // drop duplicated closing point
        local.push([p[0] - originX, p[1] - originY]);
      }
      if (local.length >= 3) rings.push(local);
    }
  }
  if (rings.length === 0) return [];

  const xSet = new Set<number>([0, extent]);
  const ySet = new Set<number>([0, extent]);
  for (const ring of rings) {
    for (const [x, y] of ring) {
      if (x > 0 && x < extent) xSet.add(x);
      if (y > 0 && y < extent) ySet.add(y);
    }
  }
  const xs = [...xSet].sort((a, b) => a - b);
  const ys = [...ySet].sort((a, b) => a - b);
  const nx = xs.length - 1;
  const ny = ys.length - 1;
  if (nx <= 0 || ny <= 0) return [];

  // Classify each grid cell by its center (doubled coordinates stay integral).
  const filled = new Uint8Array(nx * ny);
  let anyFilled = false;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const cx2 = xs[i]! + xs[i + 1]!;
      const cy2 = ys[j]! + ys[j + 1]!;
      if (pointInRings(rings, cx2, cy2)) {
        filled[j * nx + i] = 1;
        anyFilled = true;
      }
    }
  }
  if (!anyFilled) return [];

  const isFilled = (i: number, j: number): boolean =>
    i >= 0 && i < nx && j >= 0 && j < ny && filled[j * nx + i] === 1;

  // Emit boundary edges oriented clockwise (in y-down space) around filled cells.
  const edges: GridEdge[] = [];
  const outgoing = new Map<string, number[]>();
  const emit = (x1: number, y1: number, x2: number, y2: number): void => {
    const idx = edges.length;
    edges.push({ x1, y1, x2, y2, used: false });
    const key = vertexKey(x1, y1);
    const list = outgoing.get(key);
    if (list) list.push(idx);
    else outgoing.set(key, [idx]);
  };
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (!isFilled(i, j)) continue;
      const x0 = xs[i]!;
      const x1 = xs[i + 1]!;
      const y0 = ys[j]!;
      const y1 = ys[j + 1]!;
      if (!isFilled(i, j - 1)) emit(x0, y0, x1, y0); // top
      if (!isFilled(i + 1, j)) emit(x1, y0, x1, y1); // right
      if (!isFilled(i, j + 1)) emit(x1, y1, x0, y1); // bottom
      if (!isFilled(i - 1, j)) emit(x0, y1, x0, y0); // left
    }
  }

  // Trace loops. At pinch vertices (two diagonal cell pairs) pair incoming with
  // the outgoing edge that turns consistently (cross > 0), which keeps loops
  // simple instead of merging point-touching parts into a self-touching ring.
  const rawRings: Position[][] = [];
  for (let start = 0; start < edges.length; start++) {
    const first = edges[start]!;
    if (first.used) continue;
    const loop: Position[] = [[first.x1, first.y1]];
    let edge = first;
    for (;;) {
      edge.used = true;
      loop.push([edge.x2, edge.y2]);
      if (edge.x2 === first.x1 && edge.y2 === first.y1) break;
      const candidates = (outgoing.get(vertexKey(edge.x2, edge.y2)) ?? []).filter(
        (idx) => !edges[idx]!.used,
      );
      if (candidates.length === 0) break; // cannot happen for balanced graph
      let nextIdx = candidates[0]!;
      if (candidates.length > 1) {
        const inDx = edge.x2 - edge.x1;
        const inDy = edge.y2 - edge.y1;
        for (const idx of candidates) {
          const cand = edges[idx]!;
          const outDx = cand.x2 - cand.x1;
          const outDy = cand.y2 - cand.y1;
          if (inDx * outDy - inDy * outDx > 0) {
            nextIdx = idx;
            break;
          }
        }
      }
      edge = edges[nextIdx]!;
    }
    loop.pop(); // last point duplicates the first
    rawRings.push(loop);
  }

  // Simplify, drop degenerate rings.
  const simple: { points: Position[]; area2: number }[] = [];
  for (const raw of rawRings) {
    const points = simplify(raw);
    if (points.length < 3) continue;
    const area2 = signedArea2(points);
    if (area2 === 0) continue;
    simple.push({ points, area2 });
  }

  // Nesting depth via a point strictly inside each ring (midpoint of the
  // first edge nudged toward the ring interior). Doubled coordinates keep
  // this exact.
  const result: ClippedRing[] = simple.map(({ points, area2 }) => {
    const p0 = points[0]!;
    const p1 = points[1]!;
    const dx = p1[0] - p0[0];
    const dy = p1[1] - p0[1];
    // Interior lies on the left of the traced direction for positive-area
    // rings and on the right for negative-area (hole) rings.
    const side = Math.sign(area2);
    const tx2 = p0[0] + p1[0] - side * Math.sign(dy);
    const ty2 = p0[1] + p1[1] + side * Math.sign(dx);
    let depth = 0;
    for (const other of simple) {
      if (other.points === points) continue;
      if (pointInRing(other.points, tx2, ty2)) depth++;
    }
    return { points, signedArea: area2 / 2, depth };
  });

  // Enforce MVT winding: even depth (exterior) rings positive (clockwise in
  // y-down), odd depth (holes) negative.
  for (const ring of result) {
    const wantPositive = ring.depth % 2 === 0;
    if (wantPositive !== ring.signedArea > 0) {
      ring.points.reverse();
      ring.signedArea = -ring.signedArea;
    }
  }
  return result;
}
