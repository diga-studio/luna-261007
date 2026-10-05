import {
  Action,
  Branch,
  Condition,
  ProjectDefinition,
  Rule,
  ScreenDefinition,
  SessionStateView,
  TriggerRecord,
  VariableValue,
} from "./types";

export const SESSION_TTL_MS = 30 * 60 * 1000;
export const MAX_HISTORY = 20;

interface TimerSlot {
  rule: Rule;
  ruleIndex: number;
  dueAt: number;
  spent: boolean;
}

function evalCondition(cond: Condition, vars: Map<string, VariableValue>): boolean {
  const actual = vars.get(cond.variable);
  switch (cond.op) {
    case "eq":
      return actual === cond.value;
    case "neq":
      return actual !== cond.value;
    case "gt":
      return (actual as number) > (cond.value as number);
    case "gte":
      return (actual as number) >= (cond.value as number);
    case "lt":
      return (actual as number) < (cond.value as number);
    case "lte":
      return (actual as number) <= (cond.value as number);
  }
}

/** 单个回放会话，状态保存在进程内存。 */
export class Session {
  private readonly project: ProjectDefinition;
  private readonly screens: Map<string, ScreenDefinition>;
  private currentScreen: string;
  private readonly variables = new Map<string, VariableValue>();
  private history: string[] = [];
  private expired = false;
  /** 当前逻辑时间（时间戳不递减） */
  private now: number;
  /** 最近一次点按时间（创建时初始化为创建时间） */
  private lastActivity: number;
  /** 当前屏幕本轮进入的计时槽 */
  private timers: TimerSlot[] = [];

  constructor(project: ProjectDefinition, now: number) {
    this.project = project;
    this.screens = new Map(project.screens.map((s) => [s.name, s]));
    this.currentScreen = project.initialScreen;
    for (const v of project.variables) this.variables.set(v.name, v.initial);
    this.now = now;
    this.lastActivity = now;
    this.enterScreen(project.initialScreen, now);
  }

  private screenDef(name: string): ScreenDefinition {
    const def = this.screens.get(name);
    if (!def) throw new Error(`unknown screen "${name}"`);
    return def;
  }

  /** 进入屏幕：从进入时刻重新计算本轮计时 */
  private enterScreen(name: string, at: number): void {
    this.currentScreen = name;
    this.timers = [];
    const def = this.screenDef(name);
    def.rules.forEach((rule, ruleIndex) => {
      if (rule.trigger.kind === "timer") {
        this.timers.push({
          rule,
          ruleIndex,
          dueAt: at + rule.trigger.delayMs,
          spent: false,
        });
      }
    });
  }

  private expiryTime(): number {
    return this.lastActivity + SESSION_TTL_MS;
  }

  private checkExpired(at: number): boolean {
    if (!this.expired && at >= this.expiryTime()) this.expired = true;
    return this.expired;
  }

  private selectBranch(rule: Rule): number {
    for (let i = 0; i < rule.branches.length; i++) {
      const branch = rule.branches[i]!;
      if (branch.conditions.every((c) => evalCondition(c, this.variables))) return i;
    }
    return -1;
  }

  private runActions(branch: Branch, at: number): void {
    for (const action of branch.actions) {
      this.runAction(action, at);
    }
  }

  private runAction(action: Action, at: number): void {
    switch (action.kind) {
      case "set":
        this.variables.set(action.variable, action.value);
        break;
      case "add":
        this.variables.set(
          action.variable,
          (this.variables.get(action.variable) as number) + action.delta,
        );
        break;
      case "navigate":
        this.history.push(this.currentScreen);
        if (this.history.length > MAX_HISTORY) this.history.shift();
        this.enterScreen(action.screen, at);
        break;
      case "back": {
        const target = this.history.pop();
        if (target !== undefined) this.enterScreen(target, at);
        break;
      }
    }
  }

  /** 触发一条规则：选中分支则执行并记录，否则无动作 */
  private fireRule(rule: Rule, at: number, records: TriggerRecord[]): void {
    const branchIndex = this.selectBranch(rule);
    if (branchIndex < 0) return;
    const branch = rule.branches[branchIndex]!;
    records.push({
      time: at,
      screen: this.currentScreen,
      trigger: rule.trigger,
      branchIndex,
    });
    this.runActions(branch, at);
  }

  /**
   * 处理 upTo 时刻（含）之前到点的全部计时。
   * 到点不早于 expireBefore 的计时不触发（会话先过期）。
   */
  private processTimers(upTo: number, expireBefore: number, records: TriggerRecord[]): void {
    for (;;) {
      let next: TimerSlot | undefined;
      for (const slot of this.timers) {
        if (slot.spent || slot.dueAt > upTo || slot.dueAt >= expireBefore) continue;
        if (!next || slot.dueAt < next.dueAt) {
          next = slot;
        }
        // 同一时刻到点按配置顺序：timers 已按规则顺序排列，取先到的即可
      }
      if (!next) return;
      next.spent = true;
      const screenBefore = this.currentScreen;
      this.fireRule(next.rule, next.dueAt, records);
      if (this.currentScreen !== screenBefore) {
        // 已离开：原屏幕剩余计时失效（timers 已随 enterScreen 重建）
      }
    }
  }

  /** 投递带时间戳的点按，返回本次触发的规则记录 */
  tap(name: string, time: number): TriggerRecord[] {
    if (time < this.now) throw new Error("timestamps must be non-decreasing");
    this.now = time;
    const records: TriggerRecord[] = [];
    if (this.checkExpired(time)) return records;

    // 先处理同刻及之前的计时
    this.processTimers(time, this.expiryTime(), records);
    // 点按刷新活动时间（包括未匹配规则的点按）
    this.lastActivity = time;

    // 匹配当前屏幕上的点按规则，按配置顺序；离开屏幕后停止
    const entryScreen = this.currentScreen;
    const def = this.screenDef(entryScreen);
    for (const rule of def.rules) {
      if (this.currentScreen !== entryScreen) break;
      if (rule.trigger.kind === "tap" && rule.trigger.name === name) {
        this.fireRule(rule, time, records);
      }
    }
    return records;
  }

  /** 推进时间到指定时刻，返回期间触发的规则记录 */
  advanceTo(time: number): TriggerRecord[] {
    if (time < this.now) throw new Error("timestamps must be non-decreasing");
    this.now = time;
    const records: TriggerRecord[] = [];
    if (this.expired) return records;
    this.processTimers(time, this.expiryTime(), records);
    this.checkExpired(time);
    return records;
  }

  getState(): SessionStateView {
    const variables: Record<string, VariableValue> = {};
    for (const [k, v] of this.variables) variables[k] = v;
    return {
      currentScreen: this.currentScreen,
      variables,
      history: [...this.history],
      expired: this.expired,
    };
  }
}
