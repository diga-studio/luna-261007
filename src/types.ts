/** A quantized global integer coordinate: +x right, +y down. */
export type Position = [number, number];

/** Closed ring; first and last positions may or may not repeat. */
export type LinearRing = Position[];

/** GeoJSON Polygon coordinates: [outerRing, ...holeRings]. */
export type PolygonCoords = LinearRing[];

/** GeoJSON MultiPolygon coordinates. */
export type MultiPolygonCoords = PolygonCoords[];

export interface PolygonGeometry {
  type: 'Polygon';
  coordinates: PolygonCoords;
}

export interface MultiPolygonGeometry {
  type: 'MultiPolygon';
  coordinates: MultiPolygonCoords;
}

export type FeatureGeometry = PolygonGeometry | MultiPolygonGeometry;

export interface InputFeature {
  id: number;
  geometry: FeatureGeometry;
}
