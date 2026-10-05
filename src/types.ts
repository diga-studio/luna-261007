/** Scalar value allowed in event properties and match conditions. */
export type Scalar = string | number | boolean;

/** A single deduplicated, fraud-free journey event. */
export interface JourneyEvent {
  /** Globally unique integer id. */
  eventId: number;
  customerId: string | number;
  eventType: string;
  /** Integer epoch milliseconds. */
  timestamp: number;
  properties?: Record<string, Scalar>;
}

/** Definition of a single journey stage. */
export interface JourneyStageDefinition {
  eventType: string;
  /** Optional scalar equality conditions on event properties. */
  properties?: Record<string, Scalar>;
  /**
   * Number of matching events required to complete the stage.
   * Stage 1 must be 1; other stages 1..3. Defaults to 1.
   */
  count?: number;
}

/** Journey definition accepted by compileJourney. */
export type JourneyDefinition =
  | ReadonlyArray<JourneyStageDefinition>
  | { stages: ReadonlyArray<JourneyStageDefinition> };

/** A compiled, validated journey ready for analysis. */
export interface CompiledJourney {
  readonly stages: ReadonlyArray<CompiledStage>;
}

export interface CompiledStage {
  readonly eventType: string;
  readonly properties: Readonly<Record<string, Scalar>>;
  readonly count: number;
}

/** Half-open entry time range: [startInclusive, endExclusive). */
export interface JourneyRange {
  /** Inclusive lower bound on the entry (stage 1) event timestamp. */
  startInclusive: number;
  /** Exclusive upper bound on the entry (stage 1) event timestamp. */
  endExclusive: number;
}

/** Per-stage statistics computed over selected paths, counted per entry. */
export interface StageStats {
  /** 1-based stage number. */
  stage: number;
  /** Number of selected paths that reached this stage. */
  arrivals: number;
  /**
   * arrivals(stage) / arrivals(stage - 1); null for stage 1
   * and when the previous stage has zero arrivals.
   */
  conversionFromPrevious: number | null;
  /**
   * Median of (completion timestamp of this stage minus completion
   * timestamp of the previous stage) over selected paths reaching
   * this stage; null for stage 1 and when no path reaches it.
   */
  medianTransitionMs: number | null;
}

/** Result of analyzeJourney. */
export interface JourneyAnalysis {
  readonly compiled: CompiledJourney;
  readonly range: JourneyRange;
  /** Number of entry attempts (stage-1 matches inside the range). */
  readonly totalAttempts: number;
  readonly stages: ReadonlyArray<StageStats>;
  /**
   * Selected path per entry: entryEventId -> completion eventIds
   * (index 0 corresponds to stage 1). Internal; use explainAttempt.
   */
  readonly paths: ReadonlyMap<number, readonly number[]>;
}
