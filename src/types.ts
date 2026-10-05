export type Fps = 24 | 30 | 60;

export interface SegmentMeta {
  id: string;
  frameCount: string;
}

export interface Recording {
  id: string;
  fps: Fps;
  segments: SegmentMeta[];
}

export type EdlNode =
  | { id: string; type: 'source'; recordingId: string }
  | { id: string; type: 'trim'; node: string; startUs: string; endUs: string }
  | { id: string; type: 'concat'; nodes: string[] };

export interface Timeline {
  readonly root: import('./compile').CompiledNode;
  readonly totalSeconds: import('./rational').Rat;
}

export interface Duration {
  num: string;
  den: string;
}

export interface Span {
  startFrame: string;
  frameCount: string;
  recordingId: string;
  segmentId: string;
  a: string;
  b: string;
  d: string;
}

export interface PlanResult {
  spans: Span[];
  nextFrame: string | null;
}
