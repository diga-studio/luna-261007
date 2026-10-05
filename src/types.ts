/** 四个同意类别 */
export const CATEGORIES = [
  "cookies",
  "emailMarketing",
  "dataSharing",
  "personalization",
] as const;

export type Category = (typeof CATEGORIES)[number];

/** 单个类别的选择：授权或拒绝 */
export type ChoiceValue = "granted" | "rejected";

/** 完整选择：四个类别齐全 */
export type Choices = Record<Category, ChoiceValue>;

/** 部分选择：只包含明确提交的类别 */
export type PartialChoices = Partial<Record<Category, ChoiceValue>>;

/** 当前快照：完整选择 + 修订号 */
export interface Snapshot {
  revision: number;
  choices: Choices;
}

/** 部分选择命令 */
export interface SubmitChoicesCommand {
  /** 调用方保证同一用户内相同标识对应完全相同的命令 */
  requestId: string;
  /** 用户当时看到的修订号 */
  baseRevision: number;
  choices: PartialChoices;
}

/** 一键撤回命令 */
export interface WithdrawAllCommand {
  requestId: string;
}

export type WriteCommand =
  | ({ kind: "submit" } & SubmitChoicesCommand)
  | ({ kind: "withdrawAll" } & WithdrawAllCommand);

/** 写入结果 */
export type WriteResult =
  | { status: "applied"; snapshot: Snapshot }
  | { status: "conflict"; snapshot: Snapshot; conflicts: Category[] };

/** 不可改写的同意事件 */
export interface ConsentEvent {
  /** 该事件生效后的修订号（从 1 开始） */
  revision: number;
  requestId: string;
  kind: "submit" | "withdrawAll";
  /** 本事件涉及的类别 */
  touchedCategories: Category[];
  /** 本事件生效后的完整选择（可据此还原任一修订号的状态） */
  choicesAfter: Choices;
  /** 事件写入时间（ISO 字符串） */
  recordedAt: string;
}
