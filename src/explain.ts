import type { JourneyResult } from "./types";
import { analyzeCustomer, walkPath } from "./analyze";
import type { JourneyResultInternal } from "./analyze";

export function explainAttempt(result: JourneyResult, entryEventId: number): number[] | null {
  const internal = result as JourneyResultInternal;
  const customerId = internal.entryCustomer.get(entryEventId);
  if (customerId === undefined) return null;
  const events = internal.customers.get(customerId);
  if (events === undefined) return null;
  const analysis = analyzeCustomer(events, internal.compiled);
  const entries = analysis.matchLists[0];
  for (let p = 0; p < entries.length; p++) {
    if (events[entries[p]].eventId === entryEventId) {
      return walkPath(analysis, p).map((index) => events[index].eventId);
    }
  }
  return null;
}
