/** GeoJSON-style polygonal geometry with global integer coordinates (axis-aligned edges). */
export type Position = [number, number];
export type Ring = Position[];
export type PolygonCoordinates = Ring[];
export type MultiPolygonCoordinates = PolygonCoordinates[];

export interface PolygonGeometry {
  type: 'Polygon';
  coordinates: PolygonCoordinates;
}

export interface MultiPolygonGeometry {
  type: 'MultiPolygon';
  coordinates: MultiPolygonCoordinates;
}

export type AreaGeometry = PolygonGeometry | MultiPolygonGeometry;

export interface AreaFeature {
  id: number;
  geometry: AreaGeometry;
}

/** Read-only feature source produced by createSource. */
export interface FeatureSource {
  readonly features: readonly AreaFeature[];
}

/** A single output ring in tile-local integer coordinates. */
export interface ClippedRing {
  /** Vertices without duplicated closing point. */
  points: Position[];
  /** Signed area (shoelace / 2), positive means clockwise in y-down space. */
  signedArea: number;
  /** Nesting depth: 0 = exterior, 1 = hole of an exterior, etc. */
  depth: number;
}
