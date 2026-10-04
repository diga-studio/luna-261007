import { FeatureGeometry, LinearRing, Position } from './types';

/**
 * Result of clipping a feature to a tile, in tile-local coordinates.
 * Outer rings are clockwise (positive signed area, y-down);
 * hole rings are counterclockwise (negative signed area, y-down).
 */
export interface ClippedRings {
  outers: LinearRing[];
  holes: LinearRing[];
}

function allRings(geometry: FeatureGeometry): LinearRing[] {
  if (geometry.type === 'Polygon') return geometry.coordinates;
  const out: LinearRing[] = [];
  for (const poly of geometry.coordinates) for (const ring of poly) out.push(ring);
  return out;
}

/**
 * Even-odd containment test for the point (cx2/2, cy2/2).
 * Doubled coordinates keep the test exact with integer vertices.
 */
function pointInRings(rings: LinearRing[], cx2: number, cy2: number): boolean {
  let inside = false;
  for (const ring of rings) {
    const n = ring.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const x1 = ring[j][0];
      const y1 = ring[j][1];
      const x2 = ring[i][0];
      const y2 = ring[i][1];
      if (x1 !== x2) continue; // only vertical edges cross a horizontal ray
      if (2 * x1 <= cx2) continue; // edge must lie strictly right of the point
      const d1 = 2 * y1 - cy2;
      const d2 = 2 * y2 - cy2;
      if ((d1 < 0 && d2 > 0) || (d1 > 0 && d2 < 0)) inside = !inside;
    }
  }
  return inside;
}

interface DirectedEdge {
  from: number;
  to: number;
  dx: number;
  dy: number;
}

/** Twice the shoelace signed area (positive = visually clockwise, y-down). */
function signedArea2(ring: Position[]): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return sum;
}

/** Remove collinear consecutive vertices (ring is closed, no duplicate end). */
function simplify(ring: Position[]): Position[] {
  const out: Position[] = [];
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const prev = ring[(i + n - 1) % n];
    const cur = ring[i];
    const next = ring[(i + 1) % n];
    const cross =
      (cur[0] - prev[0]) * (next[1] - cur[1]) -
      (cur[1] - prev[1]) * (next[0] - cur[0]);
    if (cross !== 0) out.push(cur);
  }
  return out;
}

/**
 * Clip a feature geometry to the square
 * [originX, originX+size] x [originY, originY+size] (global coords).
 *
 * Method: build the arrangement grid from all vertex coordinates that fall
 * inside the tile plus the tile boundary, classify each cell by an exact
 * even-odd test at its (doubled) center, then trace the boundary of the
 * inside cells. At vertices where two inside regions touch only at a point
 * (checkerboard), edges are paired so the regions become separate simple
 * rings instead of one self-touching ring.
 */
export function clipGeometry(
  geometry: FeatureGeometry,
  originX: number,
  originY: number,
  size: number,
): ClippedRings {
  const local = allRings(geometry).map((ring) =>
    ring.map(([x, y]) => [x - originX, y - originY] as Position),
  );

  const xsSet = new Set<number>([0, size]);
  const ysSet = new Set<number>([0, size]);
  for (const ring of local) {
    for (const [x, y] of ring) {
      if (x > 0 && x < size) xsSet.add(x);
      if (y > 0 && y < size) ysSet.add(y);
    }
  }
  const xs = Array.from(xsSet).sort((a, b) => a - b);
  const ys = Array.from(ysSet).sort((a, b) => a - b);
  const nx = xs.length - 1;
  const ny = ys.length - 1;

  const cellInside = (i: number, j: number): boolean => {
    if (i < 0 || j < 0 || i >= nx || j >= ny) return false;
    return pointInRings(local, xs[i] + xs[i + 1], ys[j] + ys[j + 1]);
  };

  const vertexId = (i: number, j: number): number => j * (nx + 1) + i;
  const edges: DirectedEdge[] = [];
  const outgoing = new Map<number, number[]>();
  const addEdge = (from: number, to: number, dx: number, dy: number): void => {
    const idx = edges.length;
    edges.push({ from, to, dx, dy });
    const list = outgoing.get(from);
    if (list) list.push(idx);
    else outgoing.set(from, [idx]);
  };

  // Horizontal grid edges between (i,j) and (i+1,j).
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i < nx; i++) {
      const above = cellInside(i, j - 1);
      const below = cellInside(i, j);
      if (above === below) continue;
      if (below) addEdge(vertexId(i + 1, j), vertexId(i, j), -1, 0);
      else addEdge(vertexId(i, j), vertexId(i + 1, j), 1, 0);
    }
  }
  // Vertical grid edges between (i,j) and (i,j+1).
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i <= nx; i++) {
      const left = cellInside(i - 1, j);
      const right = cellInside(i, j);
      if (left === right) continue;
      if (left) addEdge(vertexId(i, j + 1), vertexId(i, j), 0, -1);
      else addEdge(vertexId(i, j), vertexId(i, j + 1), 0, 1);
    }
  }

  const used = new Array<boolean>(edges.length).fill(false);
  const outers: LinearRing[] = [];
  const holes: LinearRing[] = [];

  for (let start = 0; start < edges.length; start++) {
    if (used[start]) continue;
    const ringVerts: Position[] = [];
    let cur = start;
    while (!used[cur]) {
      used[cur] = true;
      const edge = edges[cur];
      ringVerts.push([xs[edge.from % (nx + 1)], ys[Math.floor(edge.from / (nx + 1))]]);
      const candidates = (outgoing.get(edge.to) || []).filter((idx) => !used[idx]);
      if (candidates.length === 0) break;
      let next = candidates[0];
      if (candidates.length > 1) {
        for (const idx of candidates) {
          const e = edges[idx];
          if (edge.dx * e.dy - edge.dy * e.dx < 0) {
            next = idx;
            break;
          }
        }
      }
      cur = next;
    }
    const simplified = simplify(ringVerts);
    if (simplified.length < 3) continue;
    const area2 = signedArea2(simplified);
    if (area2 === 0) continue;
    // Traced with interior on the left (y-down): negative = outer boundary,
    // positive = hole boundary. Reverse so outers are clockwise (positive)
    // and holes counterclockwise (negative) as MVT 2.1 requires.
    const ring = simplified.slice().reverse();
    if (area2 < 0) outers.push(ring);
    else holes.push(ring);
  }

  return { outers, holes };
}
