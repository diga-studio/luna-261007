export interface FenceInput {
  id: string;
  centerLat: number;
  centerLon: number;
  radiusMeters: number;
}

export const MIN_RADIUS_METERS = 50;
export const MAX_RADIUS_METERS = 5000;
export const MATCH_TOLERANCE_METERS = 0.001;
export const EARTH_RADIUS_METERS = 6371008.8;
