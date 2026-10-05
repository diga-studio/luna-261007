import { formatPath, parsePath } from "./paths.js";
import type {
  DefinitionError,
  MappingDefinition,
  PathSegment,
  Transform,
  ValidationResult,
} from "./types.js";

const INTEGER_PATTERN = /^\d+$/;

/** 目标路径前缀树节点：用于检测叶子/对象/数组容器冲突与重复目标。 */
interface TrieNode {
  leafRule: number | null;
  arrayChild: TrieNode | null;
  propChildren: Map<string, TrieNode>;
  /** 该数组层对应的源数组前缀（同一目标数组只能来自同一源数组）。 */
  arraySourcePrefix: string | null;
}

function newNode(): TrieNode {
  return { leafRule: null, arrayChild: null, propChildren: new Map(), arraySourcePrefix: null };
}

function hasChildren(node: TrieNode): boolean {
  return node.arrayChild !== null || node.propChildren.size > 0;
}

function validateTransform(
  transform: unknown,
  ruleIndex: number,
  errors: DefinitionError[],
): void {
  if (transform === undefined || transform === null) return;
  if (typeof transform !== "object") {
    errors.push({ code: "invalid_transform", message: "transform 必须是对象", ruleIndex });
    return;
  }
  const t = transform as Partial<Transform> & { kind?: unknown };
  switch (t.kind) {
    case "date":
      break;
    case "enum": {
      const values = (t as { values?: unknown }).values;
      if (
        !Array.isArray(values) ||
        values.length === 0 ||
        !values.every((v) => typeof v === "string")
      ) {
        errors.push({
          code: "invalid_transform",
          message: "enum 转换需要非空字符串数组 values",
          ruleIndex,
        });
      }
      break;
    }
    case "unit": {
      const u = t as { numerator?: unknown; denominator?: unknown; scale?: unknown };
      if (typeof u.numerator !== "string" || !INTEGER_PATTERN.test(u.numerator)) {
        errors.push({
          code: "invalid_transform",
          message: "unit 转换的 numerator 必须是整数字符串",
          ruleIndex,
        });
      }
      if (
        typeof u.denominator !== "string" ||
        !INTEGER_PATTERN.test(u.denominator) ||
        BigInt(u.denominator) === 0n
      ) {
        errors.push({
          code: "invalid_transform",
          message: "unit 转换的 denominator 必须是正整数字符串",
          ruleIndex,
        });
      }
      if (typeof u.scale !== "number" || !Number.isInteger(u.scale) || u.scale < 0 || u.scale > 6) {
        errors.push({
          code: "invalid_transform",
          message: "unit 转换的 scale 必须是 0-6 的整数",
          ruleIndex,
        });
      }
      break;
    }
    default:
      errors.push({
        code: "invalid_transform",
        message: `未知转换类型: ${String(t.kind)}`,
        ruleIndex,
      });
  }
}

/** 取路径中数组层之前（含数组段）的前缀；无数组返回 null。 */
function arrayPrefix(segments: PathSegment[]): PathSegment[] | null {
  const index = segments.findIndex((s) => s.kind === "array");
  return index === -1 ? null : segments.slice(0, index + 1);
}

/** 检查定义合法性；存在任何冲突时拒绝整份定义。 */
export function validateDefinition(definition: MappingDefinition): ValidationResult {
  const errors: DefinitionError[] = [];

  if (definition === null || typeof definition !== "object" || !Array.isArray(definition.rules)) {
    return {
      ok: false,
      errors: [{ code: "invalid_definition", message: "定义必须是含 rules 数组的对象" }],
    };
  }

  const root = newNode();

  definition.rules.forEach((rule, ruleIndex) => {
    if (rule === null || typeof rule !== "object") {
      errors.push({ code: "invalid_rule", message: "规则必须是对象", ruleIndex });
      return;
    }
    const sourceSegments = parsePath(rule.source);
    if (sourceSegments === null) {
      errors.push({
        code: "invalid_path",
        message: `非法源路径: ${String(rule.source)}`,
        ruleIndex,
      });
    }
    const targetSegments = parsePath(rule.target);
    if (targetSegments === null) {
      errors.push({
        code: "invalid_path",
        message: `非法目标路径: ${String(rule.target)}`,
        ruleIndex,
      });
    }
    validateTransform(rule.transform, ruleIndex, errors);

    if (sourceSegments === null || targetSegments === null) return;

    // 数组层级一致性：源与目标必须同时含（或同时不含）数组层。
    const sourcePrefix = arrayPrefix(sourceSegments);
    const targetPrefix = arrayPrefix(targetSegments);
    if ((sourcePrefix === null) !== (targetPrefix === null)) {
      errors.push({
        code: "array_mismatch",
        message: "源与目标必须同时保留数组层级",
        ruleIndex,
      });
      return;
    }

    // 将目标路径挂入前缀树，检测叶子/容器冲突与重复目标。
    let node = root;
    for (let i = 0; i < targetSegments.length; i += 1) {
      if (node.leafRule !== null) {
        errors.push({
          code: "target_conflict",
          message: `目标位置既是叶子又是容器（与规则 ${node.leafRule} 冲突）`,
          ruleIndex,
        });
        return;
      }
      const segment = targetSegments[i]!;
      if (segment.kind === "array") {
        if (node.propChildren.size > 0) {
          errors.push({
            code: "target_conflict",
            message: "目标位置不能兼作对象与数组容器",
            ruleIndex,
          });
          return;
        }
        if (node.arrayChild === null) {
          node.arrayChild = newNode();
          node.arraySourcePrefix = formatPath(sourcePrefix!);
        } else if (node.arraySourcePrefix !== formatPath(sourcePrefix!)) {
          errors.push({
            code: "array_source_conflict",
            message: "同一目标数组只能来自同一源数组",
            ruleIndex,
          });
          return;
        }
        node = node.arrayChild;
      } else {
        if (node.arrayChild !== null) {
          errors.push({
            code: "target_conflict",
            message: "目标位置不能兼作对象与数组容器",
            ruleIndex,
          });
          return;
        }
        let child = node.propChildren.get(segment.name);
        if (child === undefined) {
          child = newNode();
          node.propChildren.set(segment.name, child);
        }
        node = child;
      }
    }
    if (hasChildren(node)) {
      errors.push({
        code: "target_conflict",
        message: "目标位置既是叶子又是容器",
        ruleIndex,
      });
      return;
    }
    if (node.leafRule !== null) {
      errors.push({
        code: "target_conflict",
        message: `目标叶子被多条规则占用（与规则 ${node.leafRule} 冲突）`,
        ruleIndex,
      });
      return;
    }
    node.leafRule = ruleIndex;
  });

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
