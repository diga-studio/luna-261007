/**
 * BranchForge 三方文本合并的公共类型。
 * 三个输入版本与合并结果均只存在于内存中。
 */

/** 一侧相对祖先的一个改动：祖先行区间 [start, end) 被替换为 lines。 */
export interface LineChange {
  /** 祖先中的起始行号（含），从 0 开始。 */
  readonly start: number;
  /** 祖先中的结束行号（不含）。start === end 表示在该行间的纯插入。 */
  readonly end: number;
  /** 替换文本的各行（每行含其结尾的 LF，末行可能没有）。 */
  readonly lines: readonly string[];
}

/** 自动合并段：两侧改动互不影响，已合并好的正文。 */
export interface AutoSegment {
  readonly kind: "auto";
  readonly text: string;
}

/** 冲突段：需要人工决定的区域，给出三份区域文本。 */
export interface ConflictSegment {
  readonly kind: "conflict";
  /** 冲突区域在祖先中的原文。 */
  readonly ancestor: string;
  /** 只应用当前分支归入该区域改动后的区域文本。 */
  readonly ours: string;
  /** 只应用待合入分支归入该区域改动后的区域文本。 */
  readonly theirs: string;
}

export type MergeSegment = AutoSegment | ConflictSegment;

/** 合并预览：按祖先顺序排列的自动段与冲突段。 */
export interface MergePreview {
  readonly segments: readonly MergeSegment[];
  /** segments 中所有冲突段，按下标顺序排列，与解决选择一一对应。 */
  readonly conflicts: readonly ConflictSegment[];
}

/** 人工对一个冲突的选择：取任一侧，或提供替换文本。 */
export type ConflictResolution =
  | { readonly side: "ours" }
  | { readonly side: "theirs" }
  | { readonly side: "custom"; readonly text: string };
