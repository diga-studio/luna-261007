import { clipToTile } from './clip.ts';
import { encodeTileMvt, type MvtFeature } from './mvt.ts';
import type { FeatureSource, MultiPolygonCoordinates } from './types.ts';

export const TILE_EXTENT = 4096;

function normalize(feature: FeatureSource['features'][number]): MultiPolygonCoordinates {
  return feature.geometry.type === 'Polygon'
    ? [feature.geometry.coordinates]
    : feature.geometry.coordinates;
}

/** Encodes the tile (tileX, tileY) as an MVT 2.1 byte string. */
export function encodeTile(source: FeatureSource, tileX: number, tileY: number): Uint8Array {
  const originX = tileX * TILE_EXTENT;
  const originY = tileY * TILE_EXTENT;
  const out: MvtFeature[] = [];
  for (const feature of source.features) {
    const rings = clipToTile(normalize(feature), originX, originY, TILE_EXTENT);
    if (rings.length === 0) continue;
    out.push({ id: feature.id, rings });
  }
  return encodeTileMvt(out, TILE_EXTENT);
}
