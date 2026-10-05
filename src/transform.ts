import { normalizeDateTime } from "./datetime";
import { mulDivRound, parseDecimal, parseInteger } from "./decimal";
import type {
  BatchResult,
  FieldError,
  MappingDefinition,
  RecordResult,
  Transform,
} from "./types";
import { ARRAY_SEGMENT } from "./validate";

interface CompiledTransform {
  readonly kind: Transform["kind"];
  readonly enumValues: ReadonlySet<string> | null;
  readonly numerator: string;
  readonly denominator: string;
  readonly scale: number;
}

interface CompiledRule {
  readonly sourceBefore: readonly string[];
  readonly sourceAfter: readonly string[];
  readonly targetBefore: readonly string[];
  readonly targetAfter: readonly string[];
  readonly targetPath: readonly string[];
  readonly transform: CompiledTransform;
}

interface ArrayGroup {
  readonly sourceBefore: readonly string[];
  readonly targetBefore: readonly string[];
  readonly rules: readonly CompiledRule[];
}

interface CompiledDefinition {
  readonly plainRules: readonly CompiledRule[];
  readonly arrayGroups: readonly ArrayGroup[];
}

function compileTransform(transform: Transform): CompiledTransform {
  switch (transform.kind) {
    case "enum":
      return {
        kind: "enum",
        enumValues: new Set(transform.values),
        numerator: "1",
        denominator: "1",
        scale: 0,
      };
    case "unit": {
      const numerator = parseInteger(transform.numerator);
      const denominator = parseInteger(transform.denominator);
      if (numerator === null || denominator === null) {
        throw new Error("invalid unit transform; run checkDefinition first");
      }
      return {
        kind: "unit",
        enumValues: null,
        numerator: numerator.negative ? `-${numerator.digits}` : numerator.digits,
        denominator: denominator.digits,
        scale: transform.scale,
      };
    }
    default:
      return {
        kind: transform.kind,
        enumValues: null,
        numerator: "1",
        denominator: "1",
        scale: 0,
      };
  }
}

function splitPath(path: readonly string[]): { before: string[]; after: string[] } {
  const star = path.indexOf(ARRAY_SEGMENT);
  if (star === -1) return { before: [...path], after: [] };
  return { before: path.slice(0, star), after: path.slice(star + 1) };
}

function compileDefinition(definition: MappingDefinition): CompiledDefinition {
  const plainRules: CompiledRule[] = [];
  const groups = new Map<string, { sourceBefore: string[]; targetBefore: string[]; rules: CompiledRule[] }>();

  for (const rule of definition.rules) {
    const source = splitPath(rule.source);
    const target = splitPath(rule.target);
    const compiled: CompiledRule = {
      sourceBefore: source.before,
      sourceAfter: source.after,
      targetBefore: target.before,
      targetAfter: target.after,
      targetPath: rule.target,
      transform: compileTransform(rule.transform),
    };
    const isArrayRule = rule.source.includes(ARRAY_SEGMENT);
    if (!isArrayRule) {
      plainRules.push(compiled);
      continue;
    }
    const key = JSON.stringify(source.before);
    let group = groups.get(key);
    if (group === undefined) {
      group = { sourceBefore: source.before, targetBefore: target.before, rules: [] };
      groups.set(key, group);
    }
    group.rules.push(compiled);
  }

  return {
    plainRules,
    arrayGroups: [...groups.values()].map((group) => ({
      sourceBefore: group.sourceBefore,
      targetBefore: group.targetBefore,
      rules: group.rules,
    })),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MISSING = Symbol("missing");

function getPath(container: unknown, segments: readonly string[]): unknown {
  let current = container;
  for (const segment of segments) {
    if (!isPlainObject(current)) return MISSING;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return MISSING;
    current = current[segment];
  }
  return current;
}

function setPath(container: Record<string, unknown>, segments: readonly string[], value: unknown): void {
  let current = container;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index] as string;
    let next: unknown = current[segment];
    if (!isPlainObject(next)) {
      next = {};
      current[segment] = next;
    }
    current = next as Record<string, unknown>;
  }
  current[segments[segments.length - 1] as string] = value;
}

type LeafOutcome = { readonly status: "skip" } | { readonly status: "ok"; readonly value: unknown } | { readonly status: "error"; readonly message: string };

function applyLeaf(raw: unknown, transform: CompiledTransform): LeafOutcome {
  if (raw === MISSING) return { status: "skip" };
  if (raw === null) return { status: "ok", value: null };
  switch (transform.kind) {
    case "copy": {
      const t = typeof raw;
      if (t === "string" || t === "number" || t === "boolean") {
        return { status: "ok", value: raw };
      }
      return { status: "error", message: "expected a scalar leaf" };
    }
    case "date": {
      const normalized = normalizeDateTime(raw);
      if (normalized === null) {
        return { status: "error", message: "invalid RFC3339 timestamp" };
      }
      return { status: "ok", value: normalized };
    }
    case "enum": {
      if (typeof raw === "string" && transform.enumValues?.has(raw)) {
        return { status: "ok", value: raw };
      }
      return { status: "error", message: "value is not one of the declared enum values" };
    }
    case "unit": {
      const value = parseDecimal(raw);
      if (value === null) {
        return { status: "error", message: "expected a decimal string without exponent" };
      }
      const numerator = parseInteger(transform.numerator);
      const denominator = parseInteger(transform.denominator);
      if (numerator === null || denominator === null) {
        return { status: "error", message: "invalid unit transform definition" };
      }
      return { status: "ok", value: mulDivRound(value, numerator, denominator, transform.scale) };
    }
  }
}

/** 批量转换：每条源记录恰好一条输出，顺序不变。不修改入参，批次间无共享状态。 */
export function transformBatch(
  definition: MappingDefinition,
  records: readonly unknown[],
): BatchResult {
  const compiled = compileDefinition(definition);
  const results: RecordResult[] = [];
  const allErrors: FieldError[] = [];

  for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
    const record = records[recordIndex];
    const output: Record<string, unknown> = {};
    const errors: FieldError[] = [];
    const pushError = (target: readonly string[], arrayIndex: number | null, message: string): void => {
      errors.push({ recordIndex, arrayIndex, target, message });
    };

    for (const rule of compiled.plainRules) {
      const raw = getPath(record, rule.sourceBefore);
      const outcome = applyLeaf(raw, rule.transform);
      if (outcome.status === "ok") {
        setPath(output, rule.targetBefore, outcome.value);
      } else if (outcome.status === "error") {
        pushError(rule.targetPath, null, outcome.message);
      }
    }

    for (const group of compiled.arrayGroups) {
      const container = getPath(record, group.sourceBefore);
      if (container === MISSING) continue;
      if (container === null) {
        setPath(output, group.targetBefore, null);
        continue;
      }
      if (!Array.isArray(container)) {
        for (const rule of group.rules) {
          pushError(rule.targetPath, null, "expected an array at the source array position");
        }
        continue;
      }
      const targetArray: unknown[] = [];
      for (let arrayIndex = 0; arrayIndex < container.length; arrayIndex += 1) {
        const element = container[arrayIndex];
        const targetElement: Record<string, unknown> = {};
        for (const rule of group.rules) {
          const raw = getPath(element, rule.sourceAfter);
          const outcome = applyLeaf(raw, rule.transform);
          if (outcome.status === "ok") {
            setPath(targetElement, rule.targetAfter, outcome.value);
          } else if (outcome.status === "error") {
            pushError(rule.targetPath, arrayIndex, outcome.message);
          }
        }
        targetArray.push(targetElement);
      }
      setPath(output, group.targetBefore, targetArray);
    }

    results.push({ output, errors });
    allErrors.push(...errors);
  }

  return { records: results, errors: allErrors };
}
