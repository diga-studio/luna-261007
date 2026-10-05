import type { Action, Condition, Project, Value } from './types.js';

export const MIN_TIMER_DELAY_MS = 100;
export const MAX_TIMER_DELAY_MS = 10_000;

function valueType(value: Value): 'string' | 'number' | 'boolean' {
  return typeof value as 'string' | 'number' | 'boolean';
}

/** 校验项目定义，非法时抛出 Error（createSession 前调用） */
export function validateProject(project: Project): void {
  if (!project || typeof project !== 'object') {
    throw new Error('project must be an object');
  }
  const { initialScreen, variables, screens } = project;
  if (!Array.isArray(screens) || screens.length === 0) {
    throw new Error('project.screens must be a non-empty array');
  }
  if (!Array.isArray(variables)) {
    throw new Error('project.variables must be an array');
  }

  const variableTypes = new Map<string, 'string' | 'number' | 'boolean'>();
  for (const variable of variables) {
    if (!variable || typeof variable.name !== 'string' || variable.name === '') {
      throw new Error('variable must have a non-empty name');
    }
    if (variableTypes.has(variable.name)) {
      throw new Error(`duplicate variable: ${variable.name}`);
    }
    if (
      variable.type !== 'string' &&
      variable.type !== 'number' &&
      variable.type !== 'boolean'
    ) {
      throw new Error(`variable ${variable.name}: unknown type ${String(variable.type)}`);
    }
    if (valueType(variable.initial) !== variable.type) {
      throw new Error(`variable ${variable.name}: initial value type mismatch`);
    }
    variableTypes.set(variable.name, variable.type);
  }

  const screenNames = new Set<string>();
  for (const screen of screens) {
    if (!screen || typeof screen.name !== 'string' || screen.name === '') {
      throw new Error('screen must have a non-empty name');
    }
    if (screenNames.has(screen.name)) {
      throw new Error(`duplicate screen: ${screen.name}`);
    }
    screenNames.add(screen.name);
  }
  if (!screenNames.has(initialScreen)) {
    throw new Error(`initialScreen not found: ${String(initialScreen)}`);
  }

  const checkCondition = (condition: Condition, where: string): void => {
    const type = variableTypes.get(condition.variable);
    if (type === undefined) {
      throw new Error(`${where}: unknown variable ${condition.variable}`);
    }
    if (condition.op === 'eq') {
      if (valueType(condition.value) !== type) {
        throw new Error(`${where}: eq condition type mismatch on ${condition.variable}`);
      }
    } else if (
      condition.op === 'gt' ||
      condition.op === 'gte' ||
      condition.op === 'lt' ||
      condition.op === 'lte'
    ) {
      if (type !== 'number' || typeof condition.value !== 'number') {
        throw new Error(`${where}: numeric comparison requires number variable ${condition.variable}`);
      }
    } else {
      throw new Error(`${where}: unknown condition op ${String((condition as { op: unknown }).op)}`);
    }
  };

  const checkAction = (action: Action, where: string): void => {
    if (action.kind === 'set') {
      const type = variableTypes.get(action.variable);
      if (type === undefined) {
        throw new Error(`${where}: unknown variable ${action.variable}`);
      }
      if (valueType(action.value) !== type) {
        throw new Error(`${where}: set type mismatch on ${action.variable}`);
      }
    } else if (action.kind === 'adjust') {
      if (variableTypes.get(action.variable) !== 'number') {
        throw new Error(`${where}: adjust requires number variable ${action.variable}`);
      }
      if (typeof action.delta !== 'number' || !Number.isFinite(action.delta)) {
        throw new Error(`${where}: adjust delta must be a finite number`);
      }
    } else if (action.kind === 'navigate') {
      if (!screenNames.has(action.screen)) {
        throw new Error(`${where}: unknown navigate target ${action.screen}`);
      }
    } else if (action.kind !== 'back') {
      throw new Error(`${where}: unknown action kind ${String((action as { kind: unknown }).kind)}`);
    }
  };

  for (const screen of screens) {
    if (!Array.isArray(screen.rules)) {
      throw new Error(`screen ${screen.name}: rules must be an array`);
    }
    screen.rules.forEach((rule, ruleIndex) => {
      const where = `screen ${screen.name} rule ${ruleIndex}`;
      const trigger = rule.trigger;
      if (!trigger || (trigger.kind !== 'tap' && trigger.kind !== 'timer')) {
        throw new Error(`${where}: unknown trigger`);
      }
      if (trigger.kind === 'tap') {
        if (typeof trigger.name !== 'string' || trigger.name === '') {
          throw new Error(`${where}: tap trigger needs a non-empty name`);
        }
      } else {
        if (
          typeof trigger.delayMs !== 'number' ||
          !Number.isInteger(trigger.delayMs) ||
          trigger.delayMs < MIN_TIMER_DELAY_MS ||
          trigger.delayMs > MAX_TIMER_DELAY_MS
        ) {
          throw new Error(
            `${where}: timer delayMs must be an integer in [${MIN_TIMER_DELAY_MS}, ${MAX_TIMER_DELAY_MS}]`,
          );
        }
      }
      if (!Array.isArray(rule.branches)) {
        throw new Error(`${where}: branches must be an array`);
      }
      rule.branches.forEach((branch, branchIndex) => {
        const branchWhere = `${where} branch ${branchIndex}`;
        if (!Array.isArray(branch.conditions) || !Array.isArray(branch.actions)) {
          throw new Error(`${branchWhere}: conditions/actions must be arrays`);
        }
        for (const condition of branch.conditions) {
          checkCondition(condition, branchWhere);
        }
        branch.actions.forEach((action, actionIndex) => {
          checkAction(action, `${branchWhere} action ${actionIndex}`);
          if (
            (action.kind === 'navigate' || action.kind === 'back') &&
            actionIndex !== branch.actions.length - 1
          ) {
            throw new Error(`${branchWhere}: navigate/back must be the last action`);
          }
        });
      });
    });
  }
}
