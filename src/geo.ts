import { EARTH_RADIUS_METERS } from "./types.ts";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

const DEG_TO_RAD = Math.PI / 180;

export function normalizeLon(lon: number): number {
  if (lon === 180 || lon === -180) return -180;
  return lon;
}

export function latLonToVector(lat: number, lon: number): Vec3 {
  const latRad = lat * DEG_TO_RAD;
  const lonRad = normalizeLon(lon) * DEG_TO_RAD;
  const cosLat = Math.cos(latRad);
  return {
    x: cosLat * Math.cos(lonRad),
    y: cosLat * Math.sin(lonRad),
    z: Math.sin(latRad),
  };
}

export function haversineDistanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const lat1Rad = lat1 * DEG_TO_RAD;
  const lat2Rad = lat2 * DEG_TO_RAD;
  const dLat = lat2Rad - lat1Rad;
  let dLonDeg = lon2 - lon1;
  if (dLonDeg > 180) dLonDeg -= 360;
  else if (dLonDeg < -180) dLonDeg += 360;
  const dLon = dLonDeg * DEG_TO_RAD;
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const a =
    sinDLat * sinDLat +
    Math.cos(lat1Rad) * Math.cos(lat2Rad) * sinDLon * sinDLon;
  const clamped = Math.min(1, a);
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(clamped));
}
