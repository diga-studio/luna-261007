const EARTH_RADIUS_M = 6371008.8;
const DAY_MS = 86400000;

export function haversineMeters(
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
    Math.sin(dPhi / 2) * Math.sin(dPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) * Math.sin(dLambda / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
}

export function utcDayOf(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

/**
 * Split a distance traveled uniformly over [t1, t2) across UTC days,
 * proportionally to the milliseconds of the interval falling in each day.
 */
export function splitDistanceByDay(
  t1: number,
  t2: number,
  distanceMeters: number,
): Array<[string, number]> {
  const span = t2 - t1;
  if (span <= 0 || distanceMeters === 0) {
    return distanceMeters === 0 ? [] : [[utcDayOf(t1), distanceMeters]];
  }
  const parts: Array<[string, number]> = [];
  let cursor = t1;
  while (cursor < t2) {
    const dayStart = Math.floor(cursor / DAY_MS) * DAY_MS;
    const nextBoundary = Math.min(dayStart + DAY_MS, t2);
    const share = ((nextBoundary - cursor) / span) * distanceMeters;
    parts.push([utcDayOf(dayStart), share]);
    cursor = nextBoundary;
  }
  return parts;
}
