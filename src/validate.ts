import { parseInteger } from "./decimal";
import type {
  DefinitionIssue,
  DefinitionCheckResult,
  MappingDefinition,
  MappingRule,
} from "./types";

export const ARRAY_SEGMENT = "*";

interface TrieNode {
  readonly named: Map<string, TrieNode>;
  star: TrieNode | null;
  leafRule: number;
}

function makeNode(): TrieNode {
  return { named: new Map(), star: null, leafRule: -1 };
}

function isNonEmptyStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (segment) => typeof segment === "string" && segment.length > 0 && segment !== "__proto__",
    )
  );
}

function countArraySegments(path: readonly string[]): number {
  return path.filter((segment) => segment === ARRAY_SEGMENT).length;
}

function checkTransform(rule: MappingRule, index: number, issues: DefinitionIssue[]): void {
  const transform = rule.transform as { kind?: unknown } | undefined;
  if (transform === undefined || transform === null || typeof transform !== "object") {
    issues.push({ ruleIndex: index, message: "transform must be an object" });
    return;
  }
  switch (transform.kind) {
    case "copy":
    case "date":
      return;
    case "enum": {
      const values = (transform as { values?: unknown }).values;
      if (
        !Array.isArray(values) ||
        values.length === 0 ||
        values.some((value) => typeof value !== "string")
      ) {
        issues.push({ ruleIndex: index, message: "enum transform requires non-empty string values" });
      }
      return;
    }
    case "unit": {
      const t = transform as { numerator?: unknown; denominator?: unknown; scale?: unknown };
      if (parseInteger(t.numerator) === null) {
        issues.push({ ruleIndex: index, message: "unit numerator must be an integer string" });
      }
      const denominator = parseInteger(t.denominator);
      if (denominator === null || denominator.negative || denominator.digits === "0") {
        issues.push({ ruleIndex: index, message: "unit denominator must be a positive integer string" });
      }
      if (typeof t.scale !== "number" || !Number.isInteger(t.scale) || t.scale < 0 || t.scale > 6) {
        issues.push({ ruleIndex: index, message: "unit scale must be an integer between 0 and 6" });
      }
      return;
    }
    default:
      issues.push({ ruleIndex: index, message: `unknown transform kind: ${String(transform.kind)}` });
  }
}

/** 检查整份定义；有任何冲突即整体拒绝。 */
export function checkDefinition(definition: MappingDefinition): DefinitionCheckResult {
  const issues: DefinitionIssue[] = [];
  const rules = definition?.rules;
  if (!Array.isArray(rules)) {
    return { ok: false, issues: [{ ruleIndex: -1, message: "definition.rules must be an array" }] };
  }

  const root = makeNode();
  const targetArraySources = new Map<string, string>();

  rules.forEach((rule, index) => {
    if (rule === null || typeof rule !== "object") {
      issues.push({ ruleIndex: index, message: "rule must be an object" });
      return;
    }
    const { source, target } = rule;
    if (!isNonEmptyStringArray(source)) {
      issues.push({ ruleIndex: index, message: "source must be a non-empty string array" });
      return;
    }
    if (!isNonEmptyStringArray(target)) {
      issues.push({ ruleIndex: index, message: "target must be a non-empty string array" });
      return;
    }

    const sourceArrays = countArraySegments(source);
    const targetArrays = countArraySegments(target);
    if (sourceArrays > 1) {
      issues.push({ ruleIndex: index, message: "source path crosses more than one array level" });
    }
    if (targetArrays > 1) {
      issues.push({ ruleIndex: index, message: "target path crosses more than one array level" });
    }
    if (sourceArrays !== targetArrays) {
      issues.push({ ruleIndex: index, message: "source and target must both keep the array level" });
    }

    checkTransform(rule, index, issues);

    // 目标数组必须来自同一源数组。
    if (targetArrays === 1 && sourceArrays === 1) {
      const targetPrefix = JSON.stringify(target.slice(0, target.indexOf(ARRAY_SEGMENT) + 1));
      const sourcePrefix = JSON.stringify(source.slice(0, source.indexOf(ARRAY_SEGMENT) + 1));
      const existing = targetArraySources.get(targetPrefix);
      if (existing === undefined) {
        targetArraySources.set(targetPrefix, sourcePrefix);
      } else if (existing !== sourcePrefix) {
        issues.push({
          ruleIndex: index,
          message: "target array is fed by more than one source array",
        });
      }
    }

    // 目标位置冲突：叶子 / 对象容器 / 数组容器互斥，叶子唯一。
    let node = root;
    for (const segment of target) {
      if (segment === ARRAY_SEGMENT) {
        if (node.named.size > 0) {
          issues.push({
            ruleIndex: index,
            message: "target position used as both object and array container",
          });
        }
        node.star ??= makeNode();
        node = node.star;
      } else {
        if (node.star !== null) {
          issues.push({
            ruleIndex: index,
            message: "target position used as both array container and object",
          });
        }
        let child = node.named.get(segment);
        if (child === undefined) {
          child = makeNode();
          node.named.set(segment, child);
        }
        node = child;
      }
      if (node.leafRule !== -1) {
        issues.push({
          ruleIndex: index,
          message: `target leaf of rule ${node.leafRule} is reused as a container`,
        });
      }
    }
    if (node.leafRule !== -1) {
      issues.push({
        ruleIndex: index,
        message: `target leaf already produced by rule ${node.leafRule}`,
      });
    }
    if (node.named.size > 0 || node.star !== null) {
      issues.push({
        ruleIndex: index,
        message: "target leaf position is already used as a container",
      });
    }
    node.leafRule = index;
  });

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}
