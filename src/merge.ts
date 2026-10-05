import { diffLines, type Change } from "./diff";
import { splitLines } from "./lines";
import type { ConflictSegment, MergePreview, Resolution, Segment } from "./types";

interface TaggedChange extends Change {
  side: 0 | 1;
}

/**
 * Two changes interact only when their non-empty ancestor intervals
 * overlap (touching endpoints do not count); a pure insertion interacts
 * with a non-empty interval only when strictly inside it; two pure
 * insertions interact only at the same position.
 */
function interacts(a: Change, b: Change): boolean {
  const aInsertOnly = a.deleteCount === 0;
  const bInsertOnly = b.deleteCount === 0;
  if (aInsertOnly && bInsertOnly) {
    return a.start === b.start;
  }
  if (aInsertOnly) {
    return b.start < a.start && a.start < b.start + b.deleteCount;
  }
  if (bInsertOnly) {
    return a.start < b.start && b.start < a.start + a.deleteCount;
  }
  return (
    a.start < b.start + b.deleteCount && b.start < a.start + a.deleteCount
  );
}

interface Region {
  lo: number;
  hi: number;
  members: TaggedChange[];
}

/** Applies one side's in-region changes to the ancestor slice [lo, hi). */
function applySide(
  ancestorLines: string[],
  lo: number,
  hi: number,
  changes: TaggedChange[],
): string {
  const parts: string[] = [];
  let pos = lo;
  for (const change of changes) {
    for (let i = pos; i < change.start; i++) {
      parts.push(ancestorLines[i]);
    }
    parts.push(...change.inserted);
    pos = change.start + change.deleteCount;
  }
  for (let i = pos; i < hi; i++) {
    parts.push(ancestorLines[i]);
  }
  return parts.join("");
}

interface ResolvedRegion extends Region {
  /** Agreed text when both sides produced identical region results. */
  agreed: string | null;
  conflict: ConflictSegment | null;
}

type Event =
  | { kind: "insert"; lines: string[] }
  | { kind: "change"; change: TaggedChange }
  | { kind: "region"; region: ResolvedRegion };

/** Ordering rank of events sharing one ancestor position. */
function eventRank(event: Event): number {
  switch (event.kind) {
    case "insert":
      return 0;
    case "region":
      return event.region.lo === event.region.hi ? 1 : 3;
    case "change":
      return 2;
  }
}

/**
 * Builds a three-way merge preview for a single file. All inputs and the
 * result live in memory only. Non-interacting changes from both sides are
 * merged automatically; interacting changes are grouped into conflict
 * regions carrying the ancestor, current and incoming region texts.
 */
export function mergePreview(
  ancestor: string,
  current: string,
  incoming: string,
): MergePreview {
  const ancestorLines = splitLines(ancestor);
  const changesCurrent = diffLines(ancestorLines, splitLines(current));
  const changesIncoming = diffLines(ancestorLines, splitLines(incoming));
  const all: TaggedChange[] = [
    ...changesCurrent.map((c) => ({ ...c, side: 0 as const })),
    ...changesIncoming.map((c) => ({ ...c, side: 1 as const })),
  ];

  // Union-find: interacting changes belong to the same region, and the
  // relation is transitive.
  const parent = all.map((_, index) => index);
  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) {
      root = parent[root];
    }
    while (parent[x] !== root) {
      const next = parent[x];
      parent[x] = root;
      x = next;
    }
    return root;
  };
  for (let i = 0; i < changesCurrent.length; i++) {
    for (let j = 0; j < changesIncoming.length; j++) {
      const k = changesCurrent.length + j;
      if (interacts(all[i], all[k])) {
        const ri = find(i);
        const rk = find(k);
        if (ri !== rk) {
          parent[ri] = rk;
        }
      }
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < all.length; i++) {
    const root = find(i);
    const group = groups.get(root);
    if (group) {
      group.push(i);
    } else {
      groups.set(root, [i]);
    }
  }

  const events = new Map<number, Event[]>();
  const addEvent = (position: number, event: Event) => {
    const list = events.get(position);
    if (list) {
      list.push(event);
    } else {
      events.set(position, [event]);
    }
  };

  const regions: ResolvedRegion[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      // No interaction: the change merges automatically.
      const change = all[group[0]];
      if (change.deleteCount === 0) {
        addEvent(change.start, { kind: "insert", lines: change.inserted });
      } else {
        addEvent(change.start, { kind: "change", change });
      }
      continue;
    }
    const members = group.map((i) => all[i]);
    const lo = Math.min(...members.map((c) => c.start));
    const hi = Math.max(...members.map((c) => c.start + c.deleteCount));
    const region: Region = { lo, hi, members };
    const currentText = applySide(
      ancestorLines,
      lo,
      hi,
      members.filter((c) => c.side === 0),
    );
    const incomingText = applySide(
      ancestorLines,
      lo,
      hi,
      members.filter((c) => c.side === 1),
    );
    const resolved: ResolvedRegion =
      currentText === incomingText
        ? { ...region, agreed: currentText, conflict: null }
        : {
            ...region,
            agreed: null,
            conflict: {
              kind: "conflict",
              id: -1,
              ancestor: ancestorLines.slice(lo, hi).join(""),
              current: currentText,
              incoming: incomingText,
            },
          };
    regions.push(resolved);
    addEvent(lo, { kind: "region", region: resolved });
  }

  for (const list of events.values()) {
    list.sort((a, b) => eventRank(a) - eventRank(b));
  }

  const segments: Segment[] = [];
  let autoBuffer = "";
  const flushAuto = () => {
    if (autoBuffer.length > 0) {
      segments.push({ kind: "auto", text: autoBuffer });
      autoBuffer = "";
    }
  };

  let pos = 0;
  const positions = [...events.keys()].sort((a, b) => a - b);
  for (const position of positions) {
    for (let i = pos; i < position; i++) {
      autoBuffer += ancestorLines[i];
    }
    pos = position;
    for (const event of events.get(position)!) {
      if (event.kind === "insert") {
        autoBuffer += event.lines.join("");
      } else if (event.kind === "change") {
        autoBuffer += event.change.inserted.join("");
        pos = event.change.start + event.change.deleteCount;
      } else {
        const { region } = event;
        if (region.conflict) {
          flushAuto();
          segments.push(region.conflict);
        } else {
          autoBuffer += region.agreed!;
        }
        pos = region.hi;
      }
    }
  }
  for (let i = pos; i < ancestorLines.length; i++) {
    autoBuffer += ancestorLines[i];
  }
  flushAuto();

  const conflicts: ConflictSegment[] = [];
  for (const segment of segments) {
    if (segment.kind === "conflict") {
      segment.id = conflicts.length;
      conflicts.push(segment);
    }
  }
  return { segments, conflicts };
}

/**
 * Produces the final merged text from a preview and one resolution per
 * conflict. Throws unless every conflict is resolved exactly once.
 * Resolutions never alter auto-merged content outside their conflict.
 */
export function resolveMerge(
  preview: MergePreview,
  resolutions: Resolution[],
): string {
  const byId = new Map<number, Resolution>();
  for (const resolution of resolutions) {
    if (!preview.conflicts.some((c) => c.id === resolution.id)) {
      throw new Error(`unknown conflict id: ${resolution.id}`);
    }
    if (byId.has(resolution.id)) {
      throw new Error(`duplicate resolution for conflict ${resolution.id}`);
    }
    byId.set(resolution.id, resolution);
  }
  for (const conflict of preview.conflicts) {
    if (!byId.has(conflict.id)) {
      throw new Error(`unresolved conflict ${conflict.id}`);
    }
  }
  const parts: string[] = [];
  for (const segment of preview.segments) {
    if (segment.kind === "auto") {
      parts.push(segment.text);
      continue;
    }
    const resolution = byId.get(segment.id)!;
    if (resolution.choice === "current") {
      parts.push(segment.current);
    } else if (resolution.choice === "incoming") {
      parts.push(segment.incoming);
    } else {
      parts.push(resolution.text);
    }
  }
  return parts.join("");
}
