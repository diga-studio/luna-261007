/**
 * Spherical geometry primitives.
 * Earth is modeled as a sphere of radius EARTH_RADIUS_METERS.
 */

export const EARTH_RADIUS_METERS = 6371008.8;

/** Outward tolerance applied to every fence radius when matching. */
export const MATCH_TOLERANCE_METERS = 0.001;

export interface GeoPoint {
  /** Latitude in degrees, [-90, 90]. */
  readonly lat: number;
  /** Longitude in degrees, [-180, 180]. 180 and -180 denote the same meridian. */
  readonly lon: number;
}

/** A point on the unit sphere in Earth-centered Cartesian coordinates. */
export interface UnitVector {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export function isValidLat(lat: number): boolean {
  return Number.isFinite(lat) && lat >= -90 && lat <= 90;
}

export function isValidLon(lon: number): boolean {
  return Number.isFinite(lon) && lon >= -180 && lon <= 180;
}

const DEG_TO_RAD = Math.PI / 180;

/**
 * Convert a lat/lon point to its unit-sphere Cartesian vector.
 * Longitude 180 and -180 map to the same vector; at the poles every
 * longitude maps to (0, 0, ±1) up to floating-point rounding.
 */
export function toUnitVector(point: GeoPoint): UnitVector {
  const lat = point.lat * DEG_TO_RAD;
  const lon = point.lon * DEG_TO_RAD;
  const cosLat = Math.cos(lat);
  return {
    x: cosLat * Math.cos(lon),
    y: cosLat * Math.sin(lon),
    z: Math.sin(lat),
  };
}

/**
 * Great-circle (shortest arc) distance between two points on the sphere,
 * in meters. Uses the atan2 form of the central angle, which is
 * numerically stable for all separations, including antipodal and
 * near-zero distances.
 */
export function greatCircleDistanceMeters(a: GeoPoint, b: GeoPoint): number {
  const va = toUnitVector(a);
  const vb = toUnitVector(b);
  const cx = va.y * vb.z - va.z * vb.y;
  const cy = va.z * vb.x - va.x * vb.z;
  const cz = va.x * vb.y - va.y * vb.x;
  const cross = Math.sqrt(cx * cx + cy * cy + cz * cz);
  const dot = va.x * vb.x + va.y * vb.y + va.z * vb.z;
  return EARTH_RADIUS_METERS * Math.atan2(cross, dot);
}

/**
 * Chord (straight-line 3D) length on the unit sphere corresponding to a
 * great-circle arc of `arcMeters`. Monotonic in arc length, so comparing
 * squared chords is equivalent to comparing arcs.
 */
export function arcToUnitChord(arcMeters: number): number {
  return 2 * Math.sin(arcMeters / (2 * EARTH_RADIUS_METERS));
}
