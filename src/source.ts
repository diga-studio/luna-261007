import type { AreaFeature, FeatureSource } from './types.ts';

/** Builds a read-only feature source. Features are defensively copied. */
export function createSource(features: AreaFeature[]): FeatureSource {
  const seen = new Set<number>();
  const copied = features.map((feature) => {
    if (!Number.isSafeInteger(feature.id) || feature.id < 0) {
      throw new Error(`feature id must be a non-negative safe integer, got ${feature.id}`);
    }
    if (seen.has(feature.id)) {
      throw new Error(`duplicate feature id: ${feature.id}`);
    }
    seen.add(feature.id);
    const geometry =
      feature.geometry.type === 'Polygon'
        ? {
            type: 'Polygon' as const,
            coordinates: feature.geometry.coordinates.map((ring) =>
              ring.map((p) => [p[0], p[1]] as [number, number]),
            ),
          }
        : {
            type: 'MultiPolygon' as const,
            coordinates: feature.geometry.coordinates.map((polygon) =>
              polygon.map((ring) => ring.map((p) => [p[0], p[1]] as [number, number])),
            ),
          };
    return Object.freeze({ id: feature.id, geometry: Object.freeze(geometry) });
  });
  return Object.freeze({ features: Object.freeze(copied) });
}
