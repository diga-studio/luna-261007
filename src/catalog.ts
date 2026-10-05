import {
  GeoPoint,
  MATCH_TOLERANCE_METERS,
  arcToUnitChord,
  greatCircleDistanceMeters,
  isValidLat,
  isValidLon,
  toUnitVector,
} from "./geo.js";
import { GridIndex } from "./grid-index.js";

/** A circular geofence on the sphere. */
export interface Fence {
  /** Unique identifier, caller-provided. */
  readonly id: string;
  readonly center: GeoPoint;
  /** Radius in meters, [50, 5000]. */
  readonly radiusMeters: number;
}

export const MIN_RADIUS_METERS = 50;
export const MAX_RADIUS_METERS = 5000;

/**
 * Extra margin (meters) added to the fast chord-based pre-filter so that
 * floating-point rounding can never drop a true hit. Candidates passing
 * the pre-filter are re-checked with the exact great-circle distance.
 */
const FILTER_MARGIN_METERS = 1;

interface Slot {
  id: string;
  center: GeoPoint;
  radiusMeters: number;
  cx: number;
  cy: number;
  cz: number;
  /** Chord radius used for grid registration and the pre-filter. */
  chordFilter: number;
  chordFilterSq: number;
}

/**
 * In-memory geofence catalog with spherical matching.
 *
 * Not safe for concurrent use; calls are expected to be sequential.
 * All mutations take effect immediately for subsequent `match` calls.
 */
export class FenceCatalog {
  private slots: Slot[] = [];
  private freeSlots: number[] = [];
  private slotOf = new Map<string, number>();
  private index = new GridIndex();

  /** Replace the entire catalog with the given fences. */
  load(fences: readonly Fence[]): void {
    for (const fence of fences) FenceCatalog.validateFence(fence);
    this.slots = [];
    this.freeSlots = [];
    this.slotOf.clear();
    this.index.clear();
    // Later duplicates win; remove first so a repeated id never leaves
    // a stale entry behind in the index.
    for (const fence of fences) {
      this.remove(fence.id);
      this.insert(fence);
    }
  }

  /** Insert a new fence or replace the fence with the same id. */
  upsert(fence: Fence): void {
    FenceCatalog.validateFence(fence);
    this.remove(fence.id);
    this.insert(fence);
  }

  /** Batch insert/replace. Equivalent to calling `upsert` on each element. */
  upsertAll(fences: readonly Fence[]): void {
    for (const fence of fences) FenceCatalog.validateFence(fence);
    for (const fence of fences) {
      this.remove(fence.id);
      this.insert(fence);
    }
  }

  /** Remove the fence with the given id. Returns true if it existed. */
  remove(id: string): boolean {
    const slotIndex = this.slotOf.get(id);
    if (slotIndex === undefined) return false;
    const slot = this.slots[slotIndex]!;
    this.index.remove(
      slotIndex,
      { x: slot.cx, y: slot.cy, z: slot.cz },
      slot.chordFilter,
    );
    this.slotOf.delete(id);
    slot.id = "";
    this.freeSlots.push(slotIndex);
    return true;
  }

  /** Batch remove. Ids that do not exist are ignored. */
  removeAll(ids: readonly string[]): void {
    for (const id of ids) this.remove(id);
  }

  /**
   * Return the ids of all fences covering `position`: the great-circle
   * distance between position and fence center is at most
   * radius + 0.001 m. Every matching fence is returned; order unspecified.
   */
  match(position: GeoPoint): string[] {
    FenceCatalog.validatePosition(position);
    const p = toUnitVector(position);
    const candidates = this.index.candidates(p);
    if (candidates === undefined) return [];
    const hits: string[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const slot = this.slots[candidates[i]!]!;
      const dx = p.x - slot.cx;
      const dy = p.y - slot.cy;
      const dz = p.z - slot.cz;
      if (dx * dx + dy * dy + dz * dz > slot.chordFilterSq) continue;
      const distance = greatCircleDistanceMeters(position, slot.center);
      if (distance <= slot.radiusMeters + MATCH_TOLERANCE_METERS) {
        hits.push(slot.id);
      }
    }
    return hits;
  }

  get size(): number {
    return this.slotOf.size;
  }

  /** Validate a fence definition; throws RangeError/TypeError on invalid input. */
  static validateFence(fence: Fence): void {
    if (fence === null || typeof fence !== "object") {
      throw new TypeError("fence must be an object");
    }
    if (typeof fence.id !== "string" || fence.id.length === 0) {
      throw new TypeError("fence.id must be a non-empty string");
    }
    FenceCatalog.validatePosition(fence.center);
    const radius = fence.radiusMeters;
    if (
      typeof radius !== "number" ||
      !Number.isFinite(radius) ||
      radius < MIN_RADIUS_METERS ||
      radius > MAX_RADIUS_METERS
    ) {
      throw new RangeError(
        `fence.radiusMeters must be within [${MIN_RADIUS_METERS}, ${MAX_RADIUS_METERS}]`,
      );
    }
  }

  private static validatePosition(position: GeoPoint): void {
    if (position === null || typeof position !== "object") {
      throw new TypeError("position must be an object with lat/lon");
    }
    if (!isValidLat(position.lat)) {
      throw new RangeError("lat must be a finite number within [-90, 90]");
    }
    if (!isValidLon(position.lon)) {
      throw new RangeError("lon must be a finite number within [-180, 180]");
    }
  }

  private insert(fence: Fence): void {
    const vector = toUnitVector(fence.center);
    const chordFilter = arcToUnitChord(
      fence.radiusMeters + MATCH_TOLERANCE_METERS + FILTER_MARGIN_METERS,
    );
    const slotIndex = this.freeSlots.pop() ?? this.slots.length;
    const slot: Slot = {
      id: fence.id,
      center: { lat: fence.center.lat, lon: fence.center.lon },
      radiusMeters: fence.radiusMeters,
      cx: vector.x,
      cy: vector.y,
      cz: vector.z,
      chordFilter,
      chordFilterSq: chordFilter * chordFilter,
    };
    if (slotIndex === this.slots.length) {
      this.slots.push(slot);
    } else {
      this.slots[slotIndex] = slot;
    }
    this.slotOf.set(fence.id, slotIndex);
    this.index.add(slotIndex, vector, chordFilter);
  }
}
