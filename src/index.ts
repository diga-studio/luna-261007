import { Duration, EdlNode, Fps, PlanResult, Recording, Timeline } from './types';
import { compile } from './compile';
import { plan } from './plan';

export * from './types';
export { MAX_SPANS } from './plan';

export function build(recordings: Recording[], edl: EdlNode[], rootId: string): Timeline {
  const root = compile(recordings, edl, rootId);
  return { root, totalSeconds: root.total };
}

export function duration(timeline: Timeline): Duration {
  return { num: timeline.totalSeconds.n.toString(), den: timeline.totalSeconds.d.toString() };
}

export function planExport(timeline: Timeline, fps: Fps, firstFrame: string, frameCount: string): PlanResult {
  return plan(timeline, fps, firstFrame, frameCount);
}
