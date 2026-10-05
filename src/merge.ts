import { diffLines } from "./diff";
import { joinLines, splitLines } from "./lines";
import type {
  ConflictResolution,
  ConflictSegment,
  LineChange,
  MergePreview,
  MergeSegment,
} from "./types";

/** 判断分属两侧的两个改动是否互相影响。 */
function interacts(a: LineChange, b: LineChange): boolean {
  const aEmpty = a.start === a.end;
  const bEmpty = b.start === b.end;
  if (!aEmpty && !bEmpty) {
    // 非空区间有交集才算，首尾相接不算。
    return a.start < b.end && b.start < a.end;
  }
  if (aEmpty && bEmpty) {
    // 两侧同一位置的纯插入互相影响。
    return a.start === b.start;
  }
  // 纯插入严格落在另一侧非空区间内部才算，恰好在起点或终点不算。
  const point = aEmpty ? a.start : b.start;
  const range = aEmpty ? b : a;
  return range.start < point && point < range.end;
}

/** 并查集，用于把互相影响的改动按传递关系归并。 */
class UnionFind {
  private readonly parent: number[];

  constructor(size: number) {
    this.parent = new Array<number>(size);
    for (let i = 0; i < size; i++) {
      this.parent[i] = i;
    }
  }

  find(x: number): number {
    let root = x;
    while (this.parent[root] !== root) {
      root = this.parent[root]!;
    }
    while (this.parent[x] !== root) {
      const next = this.parent[x]!;
      this.parent[x] = root;
      x = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    this.parent[this.find(a)] = this.find(b);
  }
}

/** 把一侧的若干改动应用到祖先行区间 [from, to) 上，得到区域文本。 */
function applyChanges(
  ancestorLines: readonly string[],
  from: number,
  to: number,
  changes: readonly LineChange[],
): string {
  const parts: string[] = [];
  let pos = from;
  for (const change of changes) {
    for (let i = pos; i < change.start; i++) {
      parts.push(ancestorLines[i]!);
    }
    for (const line of change.lines) {
      parts.push(line);
    }
    pos = change.end;
  }
  for (let i = pos; i < to; i++) {
    parts.push(ancestorLines[i]!);
  }
  return parts.join("");
}

/** 自动应用的改动或冲突区域，按祖先区间排序后拼装预览。 */
interface Piece {
  readonly start: number;
  readonly end: number;
  readonly conflict?: ConflictSegment;
  readonly text?: string;
}

/**
 * 生成三方合并预览。
 * @param ancestor 共同祖先文本
 * @param ours 当前分支文本
 * @param theirs 待合入分支文本
 */
export function previewMerge(ancestor: string, ours: string, theirs: string): MergePreview {
  const ancestorLines = splitLines(ancestor);
  const oursChanges = diffLines(ancestorLines, splitLines(ours));
  const theirsChanges = diffLines(ancestorLines, splitLines(theirs));

  // 把互相影响的改动按传递关系归并成组。
  const uf = new UnionFind(oursChanges.length + theirsChanges.length);
  for (let a = 0; a < oursChanges.length; a++) {
    for (let b = 0; b < theirsChanges.length; b++) {
      if (interacts(oursChanges[a]!, theirsChanges[b]!)) {
        uf.union(a, oursChanges.length + b);
      }
    }
  }

  const groups = new Map<number, { ours: LineChange[]; theirs: LineChange[] }>();
  const addTo = (index: number, change: LineChange, side: "ours" | "theirs"): void => {
    const root = uf.find(index);
    let group = groups.get(root);
    if (!group) {
      group = { ours: [], theirs: [] };
      groups.set(root, group);
    }
    group[side].push(change);
  };
  oursChanges.forEach((change, index) => addTo(index, change, "ours"));
  theirsChanges.forEach((change, index) => addTo(oursChanges.length + index, change, "theirs"));

  const pieces: Piece[] = [];
  for (const group of groups.values()) {
    let start = Infinity;
    let end = -Infinity;
    for (const change of [...group.ours, ...group.theirs]) {
      start = Math.min(start, change.start);
      end = Math.max(end, change.end);
    }
    if (group.ours.length === 0 || group.theirs.length === 0) {
      // 互不影响的改动：直接保留该侧结果。
      const changes = group.ours.length > 0 ? group.ours : group.theirs;
      pieces.push({ start, end, text: applyChanges(ancestorLines, start, end, changes) });
      continue;
    }
    // 冲突区域：两侧各自只应用归入该区域的本侧改动，保留其余祖先行。
    const oursText = applyChanges(ancestorLines, start, end, group.ours);
    const theirsText = applyChanges(ancestorLines, start, end, group.theirs);
    if (oursText === theirsText) {
      // 结果相同只保留一份。
      pieces.push({ start, end, text: oursText });
    } else {
      pieces.push({
        start,
        end,
        conflict: {
          kind: "conflict",
          ancestor: joinLines(ancestorLines.slice(start, end)),
          ours: oursText,
          theirs: theirsText,
        },
      });
    }
  }
  // 同起点时纯插入（空区间）排在非空改动前：起点插入在替换文本前，
  // 终点插入因起点更大自然排在后。
  pieces.sort((a, b) => {
    if (a.start !== b.start) {
      return a.start - b.start;
    }
    const aEmpty = a.start === a.end ? 0 : 1;
    const bEmpty = b.start === b.end ? 0 : 1;
    return aEmpty - bEmpty;
  });

  // 依祖先顺序拼装：区域之间是两侧都未触碰的祖先行。
  const segments: MergeSegment[] = [];
  const conflicts: ConflictSegment[] = [];
  let autoText = "";
  const flushAuto = (): void => {
    if (autoText.length > 0) {
      segments.push({ kind: "auto", text: autoText });
      autoText = "";
    }
  };
  let pos = 0;
  for (const piece of pieces) {
    for (let i = pos; i < piece.start; i++) {
      autoText += ancestorLines[i]!;
    }
    if (piece.conflict) {
      flushAuto();
      segments.push(piece.conflict);
      conflicts.push(piece.conflict);
    } else {
      autoText += piece.text!;
    }
    pos = piece.end;
  }
  for (let i = pos; i < ancestorLines.length; i++) {
    autoText += ancestorLines[i]!;
  }
  flushAuto();

  return { segments, conflicts };
}

/**
 * 根据人工选择生成最终文本。
 * resolutions 与 preview.conflicts 一一对应；全部解决后才返回最终文本。
 * 选择只作用于冲突段，不覆盖自动合并内容；不向正文写入冲突标记。
 */
export function resolveMerge(
  preview: MergePreview,
  resolutions: readonly ConflictResolution[],
): string {
  if (resolutions.length !== preview.conflicts.length) {
    throw new Error(
      `expected ${preview.conflicts.length} resolutions, got ${resolutions.length}`,
    );
  }
  let conflictIndex = 0;
  const parts: string[] = [];
  for (const segment of preview.segments) {
    if (segment.kind === "auto") {
      parts.push(segment.text);
      continue;
    }
    const resolution = resolutions[conflictIndex]!;
    conflictIndex++;
    if (resolution.side === "ours") {
      parts.push(segment.ours);
    } else if (resolution.side === "theirs") {
      parts.push(segment.theirs);
    } else {
      parts.push(resolution.text);
    }
  }
  return parts.join("");
}
