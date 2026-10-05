import {
  Action,
  Condition,
  ProjectDefinition,
  Rule,
  ScreenDefinition,
  VariableType,
  VariableValue,
} from "./types";

export const MAX_SCREENS = 200;
export const MAX_VARIABLES = 50;
export const MIN_TIMER_DELAY_MS = 100;
export const MAX_TIMER_DELAY_MS = 10000;

function fail(message: string): never {
  throw new Error(`invalid project: ${message}`);
}

function valueType(value: VariableValue): VariableType {
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") return t;
  fail(`unsupported value ${JSON.stringify(value)}`);
}

function checkCondition(
  cond: Condition,
  varTypes: Map<string, VariableType>,
  ctx: string,
): void {
  const vt = varTypes.get(cond.variable);
  if (vt === undefined) fail(`${ctx}: condition references unknown variable "${cond.variable}"`);
  const ct = valueType(cond.value);
  if (ct !== vt) {
    fail(`${ctx}: condition on "${cond.variable}" compares ${vt} with ${ct}`);
  }
  if (cond.op !== "eq" && cond.op !== "neq" && vt !== "number") {
    fail(`${ctx}: op "${cond.op}" requires a number variable, got ${vt}`);
  }
}

function checkAction(
  action: Action,
  varTypes: Map<string, VariableType>,
  screens: Set<string>,
  ctx: string,
): void {
  switch (action.kind) {
    case "set": {
      const vt = varTypes.get(action.variable);
      if (vt === undefined) fail(`${ctx}: set references unknown variable "${action.variable}"`);
      const at = valueType(action.value);
      if (at !== vt) fail(`${ctx}: set assigns ${at} to ${vt} variable "${action.variable}"`);
      break;
    }
    case "add": {
      const vt = varTypes.get(action.variable);
      if (vt === undefined) fail(`${ctx}: add references unknown variable "${action.variable}"`);
      if (vt !== "number") fail(`${ctx}: add requires a number variable, got ${vt}`);
      if (typeof action.delta !== "number" || !Number.isFinite(action.delta)) {
        fail(`${ctx}: add delta must be a finite number`);
      }
      break;
    }
    case "navigate":
      if (!screens.has(action.screen)) fail(`${ctx}: navigate to unknown screen "${action.screen}"`);
      break;
    case "back":
      break;
  }
}

function checkRule(
  rule: Rule,
  varTypes: Map<string, VariableType>,
  screens: Set<string>,
  ctx: string,
): void {
  if (rule.trigger.kind === "tap") {
    if (typeof rule.trigger.name !== "string" || rule.trigger.name.length === 0) {
      fail(`${ctx}: tap trigger name must be a non-empty string`);
    }
  } else if (rule.trigger.kind === "timer") {
    const d = rule.trigger.delayMs;
    if (
      typeof d !== "number" ||
      !Number.isFinite(d) ||
      d < MIN_TIMER_DELAY_MS ||
      d > MAX_TIMER_DELAY_MS
    ) {
      fail(
        `${ctx}: timer delay must be between ${MIN_TIMER_DELAY_MS} and ${MAX_TIMER_DELAY_MS} ms`,
      );
    }
  } else {
    fail(`${ctx}: unknown trigger kind`);
  }
  if (!Array.isArray(rule.branches)) fail(`${ctx}: branches must be an array`);
  rule.branches.forEach((branch, i) => {
    const bctx = `${ctx} branch[${i}]`;
    branch.conditions.forEach((c) => checkCondition(c, varTypes, bctx));
    branch.actions.forEach((a) => checkAction(a, varTypes, screens, bctx));
  });
}

/** 校验项目定义，非法时抛出 Error。合法时原样返回。 */
export function validateProject(project: ProjectDefinition): ProjectDefinition {
  if (project === null || typeof project !== "object") fail("project must be an object");

  const variables = project.variables ?? [];
  const screens = project.screens ?? [];
  if (variables.length > MAX_VARIABLES) fail(`too many variables (max ${MAX_VARIABLES})`);
  if (screens.length > MAX_SCREENS) fail(`too many screens (max ${MAX_SCREENS})`);

  const varTypes = new Map<string, VariableType>();
  for (const v of variables) {
    if (typeof v.name !== "string" || v.name.length === 0) fail("variable name must be non-empty");
    if (varTypes.has(v.name)) fail(`duplicate variable "${v.name}"`);
    if (v.type !== "string" && v.type !== "number" && v.type !== "boolean") {
      fail(`variable "${v.name}" has unsupported type`);
    }
    if (valueType(v.initial) !== v.type) {
      fail(`variable "${v.name}" initial value does not match type ${v.type}`);
    }
    varTypes.set(v.name, v.type);
  }

  const screenNames = new Set<string>();
  for (const s of screens) {
    if (typeof s.name !== "string" || s.name.length === 0) fail("screen name must be non-empty");
    if (screenNames.has(s.name)) fail(`duplicate screen "${s.name}"`);
    screenNames.add(s.name);
  }
  if (!screenNames.has(project.initialScreen)) {
    fail(`initial screen "${project.initialScreen}" not found`);
  }

  for (const s of screens as ScreenDefinition[]) {
    (s.rules ?? []).forEach((r: Rule, i: number) =>
      checkRule(r, varTypes, screenNames, `screen "${s.name}" rule[${i}]`),
    );
  }
  return project;
}
