/**
 * 项目定义（JSON 可序列化）与回放引擎的公开类型。
 */

/** 变量值类型 */
export type VariableType = "string" | "number" | "boolean";
export type VariableValue = string | number | boolean;

export interface VariableDefinition {
  name: string;
  type: VariableType;
  initial: VariableValue;
}

/** 条件：同类型相等比较，或数字大小比较 */
export type ConditionOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte";

export interface Condition {
  variable: string;
  op: ConditionOp;
  value: VariableValue;
}

/** 动作：赋常量 / 数字增减 / 导航 / 返回 */
export type Action =
  | { kind: "set"; variable: string; value: VariableValue }
  | { kind: "add"; variable: string; delta: number }
  | { kind: "navigate"; screen: string }
  | { kind: "back" };

export interface Branch {
  conditions: Condition[];
  actions: Action[];
}

export type RuleTrigger =
  | { kind: "tap"; name: string }
  | { kind: "timer"; delayMs: number };

export interface Rule {
  trigger: RuleTrigger;
  branches: Branch[];
}

export interface ScreenDefinition {
  name: string;
  rules: Rule[];
}

export interface ProjectDefinition {
  initialScreen: string;
  variables: VariableDefinition[];
  screens: ScreenDefinition[];
}

/** 一次实际触发的规则记录 */
export interface TriggerRecord {
  /** 逻辑触发时间（毫秒时间戳） */
  time: number;
  screen: string;
  trigger: RuleTrigger;
  /** 命中的分支下标 */
  branchIndex: number;
}

export interface SessionStateView {
  currentScreen: string;
  variables: Record<string, VariableValue>;
  /** 返回历史，最近一项在末尾 */
  history: string[];
  expired: boolean;
}

export interface TapResult {
  triggers: TriggerRecord[];
}

export interface AdvanceResult {
  triggers: TriggerRecord[];
}
