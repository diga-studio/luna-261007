import type { ClassInput, RatioCategory } from "./types.js";
import { CLASS_CAPACITY_CAP, RATIO_LIMITS, TRANSFER_AREA_CAPACITY } from "./types.js";

/**
 * Capacity of a formal class given its current children:
 * min(CLASS_CAPACITY_CAP, teachers * strictest ratio present).
 * An empty class has no ratio restriction.
 */
export function classCapacity(
  teachers: number,
  categoriesPresent: Iterable<RatioCategory>,
): number {
  let strictest: number | null = null;
  for (const category of categoriesPresent) {
    const limit = RATIO_LIMITS[category];
    if (strictest === null || limit < strictest) {
      strictest = limit;
    }
  }
  if (strictest === null) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.min(CLASS_CAPACITY_CAP, teachers * strictest);
}

/**
 * Whether a class holding the given children (by category) is compliant.
 */
export function isClassCompliant(
  classDef: ClassInput,
  categoriesPresent: Iterable<RatioCategory>,
): boolean {
  const categories = [...categoriesPresent];
  return categories.length <= classCapacity(classDef.teachers, categories);
}

/** Whether the transfer area holding the given number of children is compliant. */
export function isTransferAreaCompliant(childCount: number): boolean {
  return childCount >= 0 && childCount <= TRANSFER_AREA_CAPACITY;
}
