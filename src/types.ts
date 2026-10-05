/** 变量值类型 */
export type Value = string | number | boolean;

/** 变量定义 */
export interface VariableDef {
  name: string;
  type: 'string' | 'number' | 'boolean';
  initial: Value;
}

/** 条件：同类型相等比较，或数字大小比较 */
export type Condition =
  | { variable: string; op: 'eq'; value: Value }
  | { variable: string; op: 'gt' | 'gte' | 'lt' | 'lte'; value: number };

/** 动作：赋常量 / 数字增减 / 导航 / 返回 */
export type Action =
  | { kind: 'set'; variable: string; value: Value }
  | { kind: 'adjust'; variable: string; delta: number }
  | { kind: 'navigate'; screen: string }
  | { kind: 'back' };

/** 有序分支：条件全部成立时按顺序执行动作 */
export interface Branch {
  conditions: Condition[];
  actions: Action[];
}

/** 规则触发器：点按名称，或进入屏幕后的计时（100~10000ms） */
export type Trigger =
  | { kind: 'tap'; name: string }
  | { kind: 'timer'; delayMs: number };

export interface Rule {
  trigger: Trigger;
  branches: Branch[];
}

export interface Screen {
  name: string;
  rules: Rule[];
}

/** 项目定义（JSON 可序列化） */
export interface Project {
  initialScreen: string;
  variables: VariableDef[];
  screens: Screen[];
}

/** 一条实际触发的规则记录 */
export interface FiredRule {
  /** 逻辑触发时间 */
  at: number;
  /** 触发时所在屏幕 */
  screen: string;
  /** 屏幕 rules 数组中的下标 */
  ruleIndex: number;
  triggerKind: 'tap' | 'timer';
  /** 选中的分支下标；无分支满足时为 null（规则仍计为已触发，不再重试） */
  branchIndex: number | null;
}

export interface InteractionResult {
  /** 本次调用实际触发规则的顺序记录 */
  fired: FiredRule[];
}

export interface SessionState {
  screen: string;
  variables: Record<string, Value>;
  history: string[];
  expired: boolean;
}

export interface Session {
  /** 投递带时间戳的点按 */
  tap(at: number, name: string): InteractionResult;
  /** 推进到指定时间，处理途中全部到点计时 */
  advanceTo(at: number): InteractionResult;
  /** 查看当前状态（不刷新活动时间）；传入 at 可按该时刻判定过期 */
  getState(at?: number): SessionState;
}
