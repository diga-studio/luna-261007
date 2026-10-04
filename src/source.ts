import { InputFeature } from './types';

/** Read-only feature source. */
export interface FeatureSource {
  readonly features: readonly InputFeature[];
}

export function createSource(features: InputFeature[]): FeatureSource {
  const seen = new Set<number>();
  for (const f of features) {
    if (seen.has(f.id)) {
      throw new Error(`duplicate feature id: ${f.id}`);
    }
    seen.add(f.id);
  }
  return Object.freeze({ features: Object.freeze(features.slice()) });
}
