import { latLonToVector } from "./geo.ts";
import {
  EARTH_RADIUS_METERS,
  MATCH_TOLERANCE_METERS,
  MAX_RADIUS_METERS,
  MIN_RADIUS_METERS,
  type FenceInput,
} from "./types.ts";

const CELL_SIZE_METERS = 500;
const AXIS_CELLS = Math.ceil((2 * EARTH_RADIUS_METERS) / CELL_SIZE_METERS) + 2;
const QUERY_REACH_METERS =
  MAX_RADIUS_METERS + MATCH_TOLERANCE_METERS + 0.001;

function cellIndexOf(coordMeters: number): number {
  return Math.floor(
    (coordMeters + EARTH_RADIUS_METERS) / CELL_SIZE_METERS
  );
}

function packCellKey(ix: number, iy: number, iz: number): number {
  return (ix * AXIS_CELLS + iy) * AXIS_CELLS + iz;
}

function validateFence(fence: FenceInput): void {
  if (typeof fence.id !== "string" || fence.id.length === 0) {
    throw new Error("fence id must be a non-empty string");
  }
  const { centerLat, centerLon, radiusMeters } = fence;
  if (
    !Number.isFinite(centerLat) ||
    centerLat < -90 ||
    centerLat > 90
  ) {
    throw new Error(`invalid centerLat for fence ${fence.id}`);
  }
  if (
    !Number.isFinite(centerLon) ||
    centerLon < -180 ||
    centerLon > 180
  ) {
    throw new Error(`invalid centerLon for fence ${fence.id}`);
  }
  if (
    !Number.isFinite(radiusMeters) ||
    radiusMeters < MIN_RADIUS_METERS ||
    radiusMeters > MAX_RADIUS_METERS
  ) {
    throw new Error(`invalid radiusMeters for fence ${fence.id}`);
  }
}

function validateLatLon(lat: number, lon: number): void {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new Error("lat must be within [-90, 90]");
  }
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw new Error("lon must be within [-180, 180]");
  }
}

export class GeoFenceCatalog {
  private ids: string[] = [];
  private idToIndex = new Map<string, number>();
  private vec = new Float64Array(0);
  private cellKeyOf: number[] = [];
  private posInCell = new Int32Array(0);
  private cells = new Map<number, number[]>();
  private freeList: number[] = [];
  private count = 0;

  get size(): number {
    return this.count;
  }

  loadAll(fences: FenceInput[]): void {
    this.ids = [];
    this.idToIndex = new Map();
    this.vec = new Float64Array(0);
    this.cellKeyOf = [];
    this.posInCell = new Int32Array(0);
    this.cells = new Map();
    this.freeList = [];
    this.count = 0;
    this.upsert(fences);
  }

  upsert(fences: FenceInput[]): void {
    for (const fence of fences) {
      validateFence(fence);
      const existing = this.idToIndex.get(fence.id);
      if (existing !== undefined) {
        this.removeAt(existing);
      }
      this.insert(fence);
    }
  }

  remove(ids: string[]): void {
    for (const id of ids) {
      const index = this.idToIndex.get(id);
      if (index !== undefined) {
        this.removeAt(index);
      }
    }
  }

  match(lat: number, lon: number): string[] {
    validateLatLon(lat, lon);
    const q = latLonToVector(lat, lon);
    const qx = q.x * EARTH_RADIUS_METERS;
    const qy = q.y * EARTH_RADIUS_METERS;
    const qz = q.z * EARTH_RADIUS_METERS;

    const ax = Math.abs(qx);
    const ay = Math.abs(qy);
    const az = Math.abs(qz);
    let a = 0;
    if (ay >= ax && ay >= az) a = 1;
    else if (az >= ax && az >= ay) a = 2;
    const u = (a + 1) % 3;
    const v = (a + 2) % 3;

    const qp = [qx, qy, qz];
    const reach = QUERY_REACH_METERS;
    const iuLo = cellIndexOf(qp[u] - reach);
    const iuHi = cellIndexOf(qp[u] + reach);
    const ivLo = cellIndexOf(qp[v] - reach);
    const ivHi = cellIndexOf(qp[v] + reach);

    const r2 = EARTH_RADIUS_METERS * EARTH_RADIUS_METERS;
    const hits: string[] = [];
    const data = this.vec;

    for (let iu = iuLo; iu <= iuHi; iu++) {
      const u0 = iu * CELL_SIZE_METERS - EARTH_RADIUS_METERS;
      const u1 = u0 + CELL_SIZE_METERS;
      const uAbsLo = u0 <= 0 && u1 >= 0 ? 0 : Math.min(Math.abs(u0), Math.abs(u1));
      const uAbsHi = Math.max(Math.abs(u0), Math.abs(u1));
      for (let iv = ivLo; iv <= ivHi; iv++) {
        const v0 = iv * CELL_SIZE_METERS - EARTH_RADIUS_METERS;
        const v1 = v0 + CELL_SIZE_METERS;
        const vAbsLo =
          v0 <= 0 && v1 >= 0 ? 0 : Math.min(Math.abs(v0), Math.abs(v1));
        const vAbsHi = Math.max(Math.abs(v0), Math.abs(v1));

        const rhoMin2 = uAbsLo * uAbsLo + vAbsLo * vAbsLo;
        if (rhoMin2 > r2) continue;
        const rhoMax2 = uAbsHi * uAbsHi + vAbsHi * vAbsHi;
        const zMax = Math.sqrt(r2 - rhoMin2);
        const zMin = rhoMax2 >= r2 ? 0 : Math.sqrt(r2 - rhoMax2);

        const sign = qp[a] >= 0 ? 1 : -1;
        const lo = sign > 0 ? zMin : -zMax;
        const hi = sign > 0 ? zMax : -zMin;
        const izLo = cellIndexOf(lo) - 1;
        const izHi = cellIndexOf(hi) + 1;

        for (let iz = izLo; iz <= izHi; iz++) {
          const key =
            a === 0
              ? packCellKey(iz, iu, iv)
              : a === 1
                ? packCellKey(iv, iz, iu)
                : packCellKey(iu, iv, iz);
          const bucket = this.cells.get(key);
          if (bucket === undefined) continue;
          for (let bi = 0; bi < bucket.length; bi++) {
            const fi = bucket[bi];
            const base = fi * 4;
            const dot =
              q.x * data[base] + q.y * data[base + 1] + q.z * data[base + 2];
            if (dot >= data[base + 3]) {
              hits.push(this.ids[fi]);
            }
          }
        }
      }
    }
    return hits;
  }

  private insert(fence: FenceInput): void {
    const slot = this.freeList.length > 0 ? this.freeList.pop()! : this.count + this.freeList.length;
    const index = slot;
    this.ensureCapacity(index + 1);

    const unit = latLonToVector(fence.centerLat, fence.centerLon);
    const base = index * 4;
    this.vec[base] = unit.x;
    this.vec[base + 1] = unit.y;
    this.vec[base + 2] = unit.z;
    this.vec[base + 3] = Math.cos(
      (fence.radiusMeters + MATCH_TOLERANCE_METERS) / EARTH_RADIUS_METERS
    );

    const ix = cellIndexOf(unit.x * EARTH_RADIUS_METERS);
    const iy = cellIndexOf(unit.y * EARTH_RADIUS_METERS);
    const iz = cellIndexOf(unit.z * EARTH_RADIUS_METERS);
    const key = packCellKey(ix, iy, iz);

    let bucket = this.cells.get(key);
    if (bucket === undefined) {
      bucket = [];
      this.cells.set(key, bucket);
    }
    this.posInCell[index] = bucket.length;
    bucket.push(index);
    this.cellKeyOf[index] = key;
    this.ids[index] = fence.id;
    this.idToIndex.set(fence.id, index);
    this.count++;
  }

  private removeAt(index: number): void {
    const key = this.cellKeyOf[index];
    const bucket = this.cells.get(key);
    if (bucket !== undefined) {
      const pos = this.posInCell[index];
      const last = bucket[bucket.length - 1];
      bucket[pos] = last;
      this.posInCell[last] = pos;
      bucket.pop();
      if (bucket.length === 0) {
        this.cells.delete(key);
      }
    }
    this.idToIndex.delete(this.ids[index]);
    this.freeList.push(index);
    this.count--;
  }

  private ensureCapacity(n: number): void {
    if (this.vec.length >= n * 4) return;
    let cap = Math.max(1024, this.vec.length / 4);
    while (cap < n) cap *= 2;
    const next = new Float64Array(cap * 4);
    next.set(this.vec);
    this.vec = next;
    const nextPos = new Int32Array(cap);
    nextPos.set(this.posInCell);
    this.posInCell = nextPos;
  }
}
