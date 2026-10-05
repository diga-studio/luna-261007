export const EARTH_RADIUS_M = 6371008.8;
export const MAX_GAP_MS = 30 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

/** Haversine distance in meters. */
export function haversineM(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = Math.PI / 180;
  const phi1 = lat1 * toRad;
  const phi2 = lat2 * toRad;
  const dPhi = (lat2 - lat1) * toRad;
  const dLambda = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dPhi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Split the distance of a segment [t1, t2) across UTC days,
 * proportional to the milliseconds spent in each day.
 * Returns [dayStartMs, meters] pairs.
 */
export function splitByDay(
  t1: number,
  t2: number,
  distanceM: number,
): Array<[number, number]> {
  const parts: Array<[number, number]> = [];
  const span = t2 - t1;
  if (span <= 0 || distanceM === 0) return parts;
  let cursor = t1;
  while (cursor < t2) {
    const dayStart = Math.floor(cursor / DAY_MS) * DAY_MS;
    const dayEnd = dayStart + DAY_MS;
    const segEnd = Math.min(dayEnd, t2);
    parts.push([dayStart, (distanceM * (segEnd - cursor)) / span]);
    cursor = segEnd;
  }
  return parts;
}
