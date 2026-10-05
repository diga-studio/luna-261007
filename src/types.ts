export type Scalar = string | number | boolean;

export interface JourneyEvent {
  eventId: number;
  customerId: string | number;
  eventType: string;
  timestamp: number;
  properties?: Record<string, unknown>;
}

export interface StageDefinition {
  eventType: string;
  properties?: Record<string, Scalar>;
  count?: number;
}

export interface JourneyDefinition {
  stages: StageDefinition[];
}

export interface TimeRange {
  start: number;
  end: number;
}

export interface CompiledStage {
  eventType: string;
  properties: Record<string, Scalar>;
  count: number;
}

export interface CompiledJourney {
  stages: CompiledStage[];
}

export interface JourneyStats {
  arrivals: number[];
  conversionRates: (number | null)[];
  transitionMedianMs: (number | null)[];
}

export interface JourneyResult {
  stats: JourneyStats;
  entryCount: number;
}
