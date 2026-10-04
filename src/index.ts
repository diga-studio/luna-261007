import { clipGeometry } from './clip';
import { encodeMvt, MvtPolygonFeature } from './mvt';
import { FeatureSource } from './source';

export const TILE_SIZE = 4096;
export const LAYER_NAME = 'terrasight';

export { createSource, FeatureSource } from './source';
export {
  InputFeature,
  FeatureGeometry,
  PolygonGeometry,
  MultiPolygonGeometry,
  LinearRing,
  Position,
} from './types';

/**
 * Encode one MVT 2.1 tile. The tile covers the global square with
 * top-left (tileX*4096, tileY*4096) and width/height 4096.
 * Every input feature with a positive-area intersection maps to exactly
 * one Polygon MVT feature keeping its original id.
 */
export function encodeTile(source: FeatureSource, tileX: number, tileY: number): Uint8Array {
  const originX = tileX * TILE_SIZE;
  const originY = tileY * TILE_SIZE;
  const out: MvtPolygonFeature[] = [];
  for (const feature of source.features) {
    const clipped = clipGeometry(feature.geometry, originX, originY, TILE_SIZE);
    if (clipped.outers.length === 0) continue;
    out.push({ id: feature.id, outers: clipped.outers, holes: clipped.holes });
  }
  return encodeMvt(out, TILE_SIZE, LAYER_NAME);
}
