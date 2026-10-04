// Geometry helpers shared by tests.

export type Pt = [number, number];

/** Twice the shoelace signed area (positive = visually clockwise, y-down). */
export function signedArea2(ring: Pt[]): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return sum;
}

/** Net covered area of a set of rings (outers positive, holes negative). */
export function netArea(rings: Pt[][]): number {
  let sum = 0;
  for (const ring of rings) sum += signedArea2(ring);
  return sum / 2;
}

/** Even-odd point containment over a set of rings. */
export function pointInRings(rings: Pt[][], px: number, py: number): boolean {
  let inside = false;
  for (const ring of rings) {
    const n = ring.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const x1 = ring[j][0];
      const y1 = ring[j][1];
      const x2 = ring[i][0];
      const y2 = ring[i][1];
      if (x1 === x2) {
        if (x1 > px && y1 !== y2 && (y1 < py) !== (y2 < py)) inside = !inside;
      } else if (y1 === y2) {
        continue;
      } else {
        // Generic edge (not expected for this library's inputs).
        const xCross = x1 + ((py - y1) * (x2 - x1)) / (y2 - y1);
        if ((y1 < py) !== (y2 < py) && xCross > px) inside = !inside;
      }
    }
  }
  return inside;
}

function segmentsIntersect(
  a1: Pt,
  a2: Pt,
  b1: Pt,
  b2: Pt,
): boolean {
  const cross = (o: Pt, p: Pt, q: Pt): number =>
    (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const onSeg = (p: Pt, q: Pt, r: Pt): boolean =>
    Math.min(p[0], r[0]) <= q[0] && q[0] <= Math.max(p[0], r[0]) &&
    Math.min(p[1], r[1]) <= q[1] && q[1] <= Math.max(p[1], r[1]);
  const d1 = cross(b1, b2, a1);
  const d2 = cross(b1, b2, a2);
  const d3 = cross(a1, a2, b1);
  const d4 = cross(a1, a2, b2);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  if (d1 === 0 && onSeg(b1, a1, b2)) return true;
  if (d2 === 0 && onSeg(b1, a2, b2)) return true;
  if (d3 === 0 && onSeg(a1, b1, a2)) return true;
  if (d4 === 0 && onSeg(a1, b2, a2)) return true;
  return false;
}

/**
 * A ring is simple when no vertex repeats and no two edges touch except
 * consecutive edges at their shared endpoint.
 */
export function ringIsSimple(ring: Pt[]): boolean {
  const n = ring.length;
  if (n < 3) return false;
  const seen = new Set<string>();
  for (const p of ring) {
    const key = p[0] + ',' + p[1];
    if (seen.has(key)) return false;
    seen.add(key);
  }
  for (let i = 0; i < n; i++) {
    const a1 = ring[i];
    const a2 = ring[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      // Skip adjacent edges (they share exactly one endpoint).
      if (j === i) continue;
      if (j === (i + 1) % n) continue;
      if (i === (j + 1) % n) continue;
      const b1 = ring[j];
      const b2 = ring[(j + 1) % n];
      if (segmentsIntersect(a1, a2, b1, b2)) return false;
    }
  }
  return true;
}
