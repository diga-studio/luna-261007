export type {
  LineChange,
  AutoSegment,
  ConflictSegment,
  MergeSegment,
  MergePreview,
  ConflictResolution,
} from "./types";
export { splitLines, joinLines } from "./lines";
export { diffLines } from "./diff";
export { previewMerge, resolveMerge } from "./merge";
