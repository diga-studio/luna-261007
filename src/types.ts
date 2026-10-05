/** Supported recording / output frame rates. */
export type Fps = 24 | 30 | 60;

/** One valid segment of a recording. Frames are numbered from 0. */
export interface Segment {
  id: string;
  /** Positive integer frame count, decimal string. */
  frameCount: string;
}

/** A recording: unique id, fixed fps, valid segments in recording order. */
export interface Recording {
  id: string;
  fps: Fps;
  segments: Segment[];
}

/** EDL node: source references a recording. */
export interface SourceNode {
  id: string;
  type: 'source';
  recordingId: string;
}

/** EDL node: trim keeps the microsecond interval [startUs, endUs) of a node. */
export interface TrimNode {
  id: string;
  type: 'trim';
  node: string;
  /** Decimal microsecond strings. */
  startUs: string;
  endUs: string;
}

/** EDL node: concat splices nodes in order; repeated references allowed. */
export interface ConcatNode {
  id: string;
  type: 'concat';
  nodes: string[];
}

export type EdlNode = SourceNode | TrimNode | ConcatNode;

/** Opaque timeline handle returned by build(). */
export interface Timeline {
  readonly _brand: 'Timeline';
}

/** Exact duration in seconds as a reduced fraction. */
export interface ExactDuration {
  /** Numerator, decimal string. */
  num: string;
  /** Denominator, decimal string (positive). */
  den: string;
}

/** One planned span: output frames mapping into one source segment occurrence. */
export interface Span {
  /** First output frame of this span, decimal string. */
  firstFrame: string;
  /** Number of output frames in this span, decimal string. */
  frameCount: string;
  recordingId: string;
  segmentId: string;
  /**
   * Source frame for the j-th frame of this span is floor((a + j*b) / d).
   * d > 0 and gcd(a, b, d) = 1. Decimal strings.
   */
  a: string;
  b: string;
  d: string;
}

export interface PlanResult {
  /** At most 128 spans. */
  spans: Span[];
  /** Frame to resume from, or null when nothing remains. */
  nextFrame: string | null;
}
