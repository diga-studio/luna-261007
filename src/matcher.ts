import type { CompiledStage, JourneyEvent } from "./types";

export function matchesStage(event: JourneyEvent, stage: CompiledStage): boolean {
  if (event.eventType !== stage.eventType) return false;
  const conditions = stage.properties;
  for (const key of Object.keys(conditions)) {
    const expected = conditions[key];
    const actual = event.properties === null || event.properties === undefined
      ? undefined
      : (event.properties as Record<string, unknown>)[key];
    if (actual !== expected) return false;
  }
  return true;
}
