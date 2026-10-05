import type { UnitVector } from "./geo.js";

/**
 * Internal spatial index over fences on the unit sphere.
 *
 * Uses a uniform 3D grid in Earth-centered Cartesian space. A fence whose
 * coverage is a spherical cap of (chord) radius d around center c is
 * registered into every grid cell intersecting the 3D ball B(c, d). A
 * lookup for point p only needs the single cell containing p: any fence
 * covering p has p inside B(c, d), hence that cell intersects B(c, d).
 *
 * The 3D grid has uniform cell size everywhere on the sphere, so it behaves
 * identically at the equator, across the antimeridian, and at the poles.
 */

/** Number of grid cells per axis; coordinates span [-1, 1]. */
const GRID_DIM = 4096;
const CELL_SIZE = 2 / GRID_DIM;
const KEY_STRIDE_Y = GRID_DIM;
const KEY_STRIDE_X = GRID_DIM * GRID_DIM;

function cellCoord(coord: number): number {
  const idx = Math.floor((coord + 1) / CELL_SIZE);
  if (idx < 0) return 0;
  if (idx >= GRID_DIM) return GRID_DIM - 1;
  return idx;
}

function cellKey(ix: number, iy: number, iz: number): number {
  return ix * KEY_STRIDE_X + iy * KEY_STRIDE_Y + iz;
}

/** Iterate the indices of all grid cells intersecting the ball B(center, radius). */
function forEachCellOfBall(
  center: UnitVector,
  radius: number,
  visit: (key: number) => void,
): void {
  const minX = cellCoord(center.x - radius);
  const maxX = cellCoord(center.x + radius);
  const minY = cellCoord(center.y - radius);
  const maxY = cellCoord(center.y + radius);
  const minZ = cellCoord(center.z - radius);
  const maxZ = cellCoord(center.z + radius);
  const radiusSq = radius * radius;
  for (let ix = minX; ix <= maxX; ix++) {
    // Closest point of this cell slab to the center, per axis.
    const cellMinX = -1 + ix * CELL_SIZE;
    const dx =
      center.x < cellMinX
        ? cellMinX - center.x
        : center.x > cellMinX + CELL_SIZE
          ? center.x - (cellMinX + CELL_SIZE)
          : 0;
    const dxSq = dx * dx;
    if (dxSq > radiusSq) continue;
    for (let iy = minY; iy <= maxY; iy++) {
      const cellMinY = -1 + iy * CELL_SIZE;
      const dy =
        center.y < cellMinY
          ? cellMinY - center.y
          : center.y > cellMinY + CELL_SIZE
            ? center.y - (cellMinY + CELL_SIZE)
            : 0;
      const dxySq = dxSq + dy * dy;
      if (dxySq > radiusSq) continue;
      for (let iz = minZ; iz <= maxZ; iz++) {
        const cellMinZ = -1 + iz * CELL_SIZE;
        const dz =
          center.z < cellMinZ
            ? cellMinZ - center.z
            : center.z > cellMinZ + CELL_SIZE
              ? center.z - (cellMinZ + CELL_SIZE)
              : 0;
        if (dxySq + dz * dz > radiusSq) continue;
        visit(cellKey(ix, iy, iz));
      }
    }
  }
}

export class GridIndex {
  private cells = new Map<number, number[]>();
  private entryCount = 0;

  /** Insert entry `id` covering the cap around `center` with the given chord radius. */
  add(id: number, center: UnitVector, chordRadius: number): void {
    forEachCellOfBall(center, chordRadius, (key) => {
      const bucket = this.cells.get(key);
      if (bucket === undefined) {
        this.cells.set(key, [id]);
      } else {
        bucket.push(id);
      }
    });
    this.entryCount++;
  }

  /** Remove a previously added entry. Must match the arguments used for `add`. */
  remove(id: number, center: UnitVector, chordRadius: number): void {
    forEachCellOfBall(center, chordRadius, (key) => {
      const bucket = this.cells.get(key);
      if (bucket === undefined) return;
      const at = bucket.indexOf(id);
      if (at === -1) return;
      const last = bucket.length - 1;
      bucket[at] = bucket[last]!;
      bucket.pop();
      if (bucket.length === 0) this.cells.delete(key);
    });
    this.entryCount--;
  }

  /**
   * Ids registered in the cell containing `p`, or undefined when empty.
   * Conservative: may contain entries whose cap does not cover `p`;
   * never misses an entry whose cap covers `p`.
   */
  candidates(p: UnitVector): readonly number[] | undefined {
    return this.cells.get(cellKey(cellCoord(p.x), cellCoord(p.y), cellCoord(p.z)));
  }

  clear(): void {
    this.cells.clear();
    this.entryCount = 0;
  }

  get size(): number {
    return this.entryCount;
  }
}
