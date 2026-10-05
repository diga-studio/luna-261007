import { validateProject } from './validate.js';
import type {
  Action,
  Branch,
  Condition,
  FiredRule,
  InteractionResult,
  Project,
  Rule,
  Screen,
  Session,
  SessionState,
  Value,
} from './types.js';

/** 会话空闲过期时长：30 分钟 */
export const SESSION_TTL_MS = 30 * 60 * 1000;
/** 返回历史上限 */
export const MAX_HISTORY = 20;

interface PendingTimer {
  ruleIndex: number;
  dueAt: number;
}

function conditionHolds(condition: Condition, variables: Record<string, Value>): boolean {
  const actual = variables[condition.variable];
  switch (condition.op) {
    case 'eq':
      return actual === condition.value;
    case 'gt':
      return (actual as number) > condition.value;
    case 'gte':
      return (actual as number) >= condition.value;
    case 'lt':
      return (actual as number) < condition.value;
    case 'lte':
      return (actual as number) <= condition.value;
  }
}

function selectBranch(rule: Rule, variables: Record<string, Value>): number | null {
  for (let index = 0; index < rule.branches.length; index += 1) {
    const branch = rule.branches[index] as Branch;
    if (branch.conditions.every((condition) => conditionHolds(condition, variables))) {
      return index;
    }
  }
  return null;
}

/** 创建会话：从初始屏幕与初始变量值开始，活动时间初始化为 now */
export function createSession(project: Project, now: number): Session {
  validateProject(project);
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new Error('now must be a finite number');
  }

  const screens = new Map<string, Screen>();
  for (const screen of project.screens) {
    screens.set(screen.name, screen);
  }

  const variables: Record<string, Value> = {};
  for (const variable of project.variables) {
    variables[variable.name] = variable.initial;
  }

  let current: Screen = screens.get(project.initialScreen) as Screen;
  let history: string[] = [];
  let pending: PendingTimer[] = [];
  let lastActivity = now;
  let lastSeenTime = now;
  let expired = false;

  const expiryAt = (): number => lastActivity + SESSION_TTL_MS;
  const isExpiredAt = (at: number): boolean => expired || at >= expiryAt();

  const scheduleTimers = (screen: Screen, enteredAt: number): void => {
    pending = [];
    screen.rules.forEach((rule, ruleIndex) => {
      if (rule.trigger.kind === 'timer') {
        pending.push({ ruleIndex, dueAt: enteredAt + rule.trigger.delayMs });
      }
    });
  };

  const enterScreen = (name: string, at: number): void => {
    current = screens.get(name) as Screen;
    scheduleTimers(current, at);
  };

  const navigateTo = (name: string, at: number): void => {
    history.push(current.name);
    if (history.length > MAX_HISTORY) {
      history.shift();
    }
    enterScreen(name, at);
  };

  const goBack = (at: number): void => {
    const target = history.pop();
    if (target === undefined) {
      return;
    }
    enterScreen(target, at);
  };

  const executeActions = (actions: Action[], at: number): void => {
    for (const action of actions) {
      if (action.kind === 'set') {
        variables[action.variable] = action.value;
      } else if (action.kind === 'adjust') {
        variables[action.variable] = (variables[action.variable] as number) + action.delta;
      } else if (action.kind === 'navigate') {
        navigateTo(action.screen, at);
      } else {
        goBack(at);
      }
    }
  };

  /** 触发一条规则：按当时变量选首个满足的分支并顺序执行；无满足分支则无动作 */
  const fireRule = (screen: Screen, ruleIndex: number, at: number, fired: FiredRule[]): void => {
    const rule = screen.rules[ruleIndex] as Rule;
    const branchIndex = selectBranch(rule, variables);
    fired.push({
      at,
      screen: screen.name,
      ruleIndex,
      triggerKind: rule.trigger.kind,
      branchIndex,
    });
    if (branchIndex !== null) {
      const branch = rule.branches[branchIndex] as Branch;
      executeActions(branch.actions, at);
    }
  };

  /**
   * 处理到点计时（含中途新进入屏幕产生的计时）。
   * inclusive 为 true 时含同刻；为 false 时只处理严格早于 horizon 的（用于过期让位）。
   */
  const processTimers = (horizon: number, inclusive: boolean, fired: FiredRule[]): void => {
    const isDue = (dueAt: number): boolean =>
      dueAt < horizon || (inclusive && dueAt === horizon);
    for (;;) {
      let next: PendingTimer | null = null;
      for (const timer of pending) {
        if (!isDue(timer.dueAt)) {
          continue;
        }
        if (next === null || timer.dueAt < next.dueAt ||
            (timer.dueAt === next.dueAt && timer.ruleIndex < next.ruleIndex)) {
          next = timer;
        }
      }
      if (next === null) {
        return;
      }
      pending = pending.filter((timer) => timer !== next);
      fireRule(current, next.ruleIndex, next.dueAt, fired);
    }
  };

  const checkClock = (at: number): void => {
    if (typeof at !== 'number' || !Number.isFinite(at)) {
      throw new Error('timestamp must be a finite number');
    }
    if (at < lastSeenTime) {
      throw new Error(`timestamps must be non-decreasing (last ${lastSeenTime}, got ${at})`);
    }
    lastSeenTime = at;
  };

  enterScreen(project.initialScreen, now);

  return {
    tap(at: number, name: string): InteractionResult {
      checkClock(at);
      const fired: FiredRule[] = [];
      if (isExpiredAt(at)) {
        expired = true;
        return { fired };
      }
      lastActivity = at;
      processTimers(at, true, fired);
      const ruleIndex = current.rules.findIndex(
        (rule) => rule.trigger.kind === 'tap' && rule.trigger.name === name,
      );
      if (ruleIndex !== -1) {
        fireRule(current, ruleIndex, at, fired);
      }
      return { fired };
    },

    advanceTo(at: number): InteractionResult {
      checkClock(at);
      const fired: FiredRule[] = [];
      if (expired) {
        return { fired };
      }
      // 到期优先于同刻计时：推进到/超过到期时刻时，只处理严格早于到期时刻的计时
      const horizon = Math.min(at, expiryAt());
      processTimers(horizon, horizon < expiryAt(), fired);
      if (at >= expiryAt()) {
        expired = true;
      }
      return { fired };
    },

    getState(at?: number): SessionState {
      if (at !== undefined) {
        checkClock(at);
        if (isExpiredAt(at)) {
          expired = true;
        }
      }
      return {
        screen: current.name,
        variables: { ...variables },
        history: [...history],
        expired,
      };
    },
  };
}
