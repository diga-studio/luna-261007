/** Ratio category of a child, given directly by the caller. */
export type RatioCategory = "infant" | "toddler" | "preschool";

/** Maximum children per teacher for each ratio category. */
export const RATIO_LIMITS: Readonly<Record<RatioCategory, number>> = {
  infant: 4,
  toddler: 6,
  preschool: 10,
};

/** Absolute capacity cap of any formal class, regardless of teachers. */
export const CLASS_CAPACITY_CAP = 20;

/** Id of the temporary transfer area used in move records. */
export const TRANSFER_AREA_ID = "__transfer_area__";

/** Capacity of the transfer area (1 dedicated teacher, at most 2 children). */
export const TRANSFER_AREA_CAPACITY = 2;

export interface ClassInput {
  id: string;
  teachers: number;
}

export interface ChildInput {
  id: string;
  category: RatioCategory;
  initialClassId: string;
  targetClassId: string;
}

export interface PlanInput {
  classes: ClassInput[];
  children: ChildInput[];
}

/** One atomic handover of a single child. */
export interface Move {
  childId: string;
  /** Class id, or TRANSFER_AREA_ID. */
  from: string;
  /** Class id, or TRANSFER_AREA_ID. */
  to: string;
}

export interface PlanSuccess {
  ok: true;
  /** Globally minimal complete move sequence. */
  moves: Move[];
}

export interface PlanFailure {
  ok: false;
  reason: string;
}

export type PlanResult = PlanSuccess | PlanFailure;

export interface PlanOptions {
  /**
   * Safety bound on BFS search states. When exceeded, planning aborts with
   * ok:false (this is NOT a proof of impossibility). Defaults to 2,000,000.
   */
  maxStates?: number;
}

export interface VerifySuccess {
  ok: true;
}

export interface VerifyFailure {
  ok: false;
  /** Index of the move that broke the rules, if a specific move is at fault. */
  moveIndex?: number;
  reason: string;
}

export type VerifyResult = VerifySuccess | VerifyFailure;
