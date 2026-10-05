/** A segment of the merge preview that was merged automatically. */
export interface AutoSegment {
  kind: "auto";
  /** Merged text for this segment, spliced into the final output as-is. */
  text: string;
}

/** A segment of the merge preview where both sides touched the same region. */
export interface ConflictSegment {
  kind: "conflict";
  /** Stable id of this conflict within a preview (0-based, in document order). */
  id: number;
  /** Region text from the common ancestor. */
  ancestor: string;
  /** Region text after applying only the current branch's changes. */
  current: string;
  /** Region text after applying only the incoming branch's changes. */
  incoming: string;
}

export type Segment = AutoSegment | ConflictSegment;

/** Merge preview: ordered segments covering the whole merged document. */
export interface MergePreview {
  segments: Segment[];
  /** Conflicts in document order; empty when the merge is clean. */
  conflicts: ConflictSegment[];
}

/** Human decision for a single conflict. */
export type Resolution =
  | { id: number; choice: "current" }
  | { id: number; choice: "incoming" }
  | { id: number; choice: "replace"; text: string };
