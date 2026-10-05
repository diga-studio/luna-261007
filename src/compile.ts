import type {
  CompiledJourney,
  CompiledStage,
  JourneyDefinition,
  JourneyStageDefinition,
  Scalar,
} from "./types";

const MAX_STAGES = 20;

function isScalar(value: unknown): value is Scalar {
  const t = typeof value;
  return t === "string" || t === "number" || t === "boolean";
}

function compileStage(
  raw: JourneyStageDefinition,
  index: number,
): CompiledStage {
  if (raw === null || typeof raw !== "object") {
    throw new Error(`stage ${index + 1}: must be an object`);
  }
  if (typeof raw.eventType !== "string" || raw.eventType.length === 0) {
    throw new Error(`stage ${index + 1}: eventType must be a non-empty string`);
  }

  const properties: Record<string, Scalar> = {};
  if (raw.properties !== undefined) {
    if (raw.properties === null || typeof raw.properties !== "object") {
      throw new Error(`stage ${index + 1}: properties must be an object`);
    }
    for (const [key, value] of Object.entries(raw.properties)) {
      if (!isScalar(value)) {
        throw new Error(
          `stage ${index + 1}: property "${key}" must be a scalar (string, number or boolean)`,
        );
      }
      properties[key] = value;
    }
  }

  const count = raw.count === undefined ? 1 : raw.count;
  if (!Number.isInteger(count)) {
    throw new Error(`stage ${index + 1}: count must be an integer`);
  }
  if (index === 0) {
    if (count !== 1) {
      throw new Error("stage 1: count must be 1");
    }
  } else if (count < 1 || count > 3) {
    throw new Error(`stage ${index + 1}: count must be between 1 and 3`);
  }

  return { eventType: raw.eventType, properties, count };
}

/**
 * Validates and compiles a journey definition of at most 20 stages.
 * Accepts either an array of stages or an object with a `stages` array.
 * Throws on invalid definitions.
 */
export function compileJourney(definition: JourneyDefinition): CompiledJourney {
  const rawStages = Array.isArray(definition)
    ? definition
    : definition === null || typeof definition !== "object"
      ? null
      : (definition as { stages?: unknown }).stages;
  if (!Array.isArray(rawStages)) {
    throw new Error("definition must be an array of stages or { stages: [...] }");
  }
  if (rawStages.length === 0) {
    throw new Error("definition must contain at least 1 stage");
  }
  if (rawStages.length > MAX_STAGES) {
    throw new Error(`definition must contain at most ${MAX_STAGES} stages`);
  }
  const stages = rawStages.map((raw, index) =>
    compileStage(raw as JourneyStageDefinition, index),
  );
  return Object.freeze({ stages: Object.freeze(stages) });
}
