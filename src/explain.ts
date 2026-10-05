import type { JourneyAnalysis } from "./types";

/**
 * Returns the completion eventId of every stage reached by the selected
 * path of the given entry (index 0 = stage 1, i.e. the entry event itself).
 * Throws if entryEventId is not an entry of this analysis.
 */
export function explainAttempt(
  result: JourneyAnalysis,
  entryEventId: number,
): readonly number[] {
  const path = result.paths.get(entryEventId);
  if (path === undefined) {
    throw new Error(
      `entryEventId ${entryEventId} is not an entry of this analysis`,
    );
  }
  return path;
}
