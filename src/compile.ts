import type { CompiledJourney, CompiledStage, JourneyDefinition, Scalar } from "./types";

export const MAX_STAGES = 20;
export const MIN_LATER_STAGE_COUNT = 1;
export const MAX_LATER_STAGE_COUNT = 3;

function isScalar(value: unknown): value is Scalar {
  const t = typeof value;
  if (t === "string" || t === "boolean") return true;
  return t === "number" && Number.isFinite(value as number);
}

function compileStage(
  raw: JourneyDefinition["stages"][number],
  index: number,
): CompiledStage {
  if (raw === null || typeof raw !== "object") {
    throw new Error(`stage ${index}: must be an object`);
  }
  if (typeof raw.eventType !== "string" || raw.eventType.length === 0) {
    throw new Error(`stage ${index}: eventType must be a non-empty string`);
  }
  const properties: Record<string, Scalar> = {};
  if (raw.properties !== undefined) {
    if (raw.properties === null || typeof raw.properties !== "object") {
      throw new Error(`stage ${index}: properties must be an object of scalar values`);
    }
    for (const [key, value] of Object.entries(raw.properties)) {
      if (!isScalar(value)) {
        throw new Error(`stage ${index}: property "${key}" must be a scalar (string, number or boolean)`);
      }
      properties[key] = value;
    }
  }
  const count = raw.count === undefined ? 1 : raw.count;
  if (!Number.isInteger(count)) {
    throw new Error(`stage ${index}: count must be an integer`);
  }
  if (index === 0) {
    if (count !== 1) {
      throw new Error("stage 0: count of the first stage must be 1");
    }
  } else if (count < MIN_LATER_STAGE_COUNT || count > MAX_LATER_STAGE_COUNT) {
    throw new Error(
      `stage ${index}: count must be between ${MIN_LATER_STAGE_COUNT} and ${MAX_LATER_STAGE_COUNT}`,
    );
  }
  return { eventType: raw.eventType, properties, count };
}

export function compileJourney(definition: JourneyDefinition): CompiledJourney {
  if (definition === null || typeof definition !== "object" || !Array.isArray(definition.stages)) {
    throw new Error("definition must be an object with a stages array");
  }
  if (definition.stages.length === 0) {
    throw new Error("definition must contain at least one stage");
  }
  if (definition.stages.length > MAX_STAGES) {
    throw new Error(`definition must contain at most ${MAX_STAGES} stages`);
  }
  return { stages: definition.stages.map(compileStage) };
}
