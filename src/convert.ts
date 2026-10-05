import { normalizeDate } from "./date.js";
import { matchEnum } from "./enumTransform.js";
import { formatPath, parsePath } from "./paths.js";
import type {
  ConvertResult,
  FieldError,
  JsonObject,
  JsonValue,
  MappingDefinition,
  PathSegment,
  Transform,
} from "./types.js";
import { convertUnit } from "./unit.js";
import { validateDefinition } from "./validate.js";

interface CompiledRule {
  sourceSegments: PathSegment[];
  targetSegments: PathSegment[];
  transform: Transform | undefined;
  sourceArrayIndex: number; // -1 表示不涉及数组
  targetArrayIndex: number;
  sourcePath: string;
  targetPath: string;
}

interface ArrayGroup {
  sourcePrefix: PathSegment[]; // 含数组段
  targetPrefix: PathSegment[]; // 含数组段
  rules: CompiledRule[];
}

type Lookup = { found: true; value: JsonValue } | { found: false };

function isObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 沿属性段向下查找；中途缺失或遇到非对象均视为未找到。 */
function lookup(container: JsonValue, segments: PathSegment[]): Lookup {
  let current: JsonValue = container;
  for (const segment of segments) {
    if (!isObject(current) || segment.kind !== "prop") return { found: false };
    if (!Object.prototype.hasOwnProperty.call(current, segment.name)) {
      return { found: false };
    }
    current = current[segment.name]!;
  }
  return { found: true, value: current };
}

/** 在输出对象上沿属性段（至少一段）创建/下钻对象，返回最终属性所属对象与属性名。 */
function ensureContainer(
  root: JsonObject,
  segments: PathSegment[],
): { parent: JsonObject; key: string } {
  let current = root;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i]!;
    if (segment.kind !== "prop") throw new Error("目标路径结构异常");
    const next = current[segment.name];
    if (next === undefined) {
      const created: JsonObject = {};
      current[segment.name] = created;
      current = created;
    } else if (isObject(next)) {
      current = next;
    } else {
      throw new Error("目标路径结构异常");
    }
  }
  const last = segments[segments.length - 1]!;
  if (last.kind !== "prop") throw new Error("目标路径结构异常");
  return { parent: current, key: last.name };
}

type TransformOutcome = { ok: true; value: JsonValue } | { ok: false; reason: string };

/** 对标量叶子执行转换（无转换表示原样复制，仅接受标量）。 */
function applyTransform(transform: Transform | undefined, value: JsonValue): TransformOutcome {
  if (transform === undefined) {
    if (value === null || typeof value === "object") {
      return { ok: false, reason: "源叶子不是标量" };
    }
    return { ok: true, value };
  }
  switch (transform.kind) {
    case "date": {
      if (typeof value !== "string") return { ok: false, reason: "日期输入不是字符串" };
      const result = normalizeDate(value);
      return result === null
        ? { ok: false, reason: `非法 RFC3339 时间戳: ${value}` }
        : { ok: true, value: result };
    }
    case "enum": {
      const result = matchEnum(value, transform.values);
      return result === null
        ? { ok: false, reason: `未声明的枚举值: ${String(value)}` }
        : { ok: true, value: result };
    }
    case "unit": {
      if (typeof value !== "string") return { ok: false, reason: "单位换算输入不是字符串" };
      const result = convertUnit(
        value,
        transform.numerator,
        transform.denominator,
        transform.scale,
      );
      return result === null
        ? { ok: false, reason: `非法十进制字符串: ${value}` }
        : { ok: true, value: result };
    }
  }
}

/** 处理单个叶子值：显式 null 原样保留且不转换；失败仅省略该叶子并记录错误。 */
function placeLeaf(
  rule: CompiledRule,
  raw: JsonValue,
  recordIndex: number,
  arrayIndex: number | null,
  set: (value: JsonValue) => void,
  errors: FieldError[],
): void {
  if (raw === null) {
    set(null);
    return;
  }
  const outcome = applyTransform(rule.transform, raw);
  if (outcome.ok) {
    set(outcome.value);
  } else {
    errors.push({
      recordIndex,
      arrayIndex,
      sourcePath: rule.sourcePath,
      targetPath: rule.targetPath,
      reason: outcome.reason,
    });
  }
}

function compileRules(definition: MappingDefinition): {
  plainRules: CompiledRule[];
  arrayGroups: ArrayGroup[];
} {
  const plainRules: CompiledRule[] = [];
  const groups = new Map<string, ArrayGroup>();
  for (const rule of definition.rules) {
    const sourceSegments = parsePath(rule.source)!;
    const targetSegments = parsePath(rule.target)!;
    const compiled: CompiledRule = {
      sourceSegments,
      targetSegments,
      transform: rule.transform,
      sourceArrayIndex: sourceSegments.findIndex((s) => s.kind === "array"),
      targetArrayIndex: targetSegments.findIndex((s) => s.kind === "array"),
      sourcePath: rule.source,
      targetPath: rule.target,
    };
    if (compiled.sourceArrayIndex === -1) {
      plainRules.push(compiled);
    } else {
      const targetPrefix = targetSegments.slice(0, compiled.targetArrayIndex + 1);
      const key = formatPath(targetPrefix);
      let group = groups.get(key);
      if (group === undefined) {
        group = {
          sourcePrefix: sourceSegments.slice(0, compiled.sourceArrayIndex + 1),
          targetPrefix,
          rules: [],
        };
        groups.set(key, group);
      }
      group.rules.push(compiled);
    }
  }
  return { plainRules, arrayGroups: [...groups.values()] };
}

function applyPlainRule(
  rule: CompiledRule,
  record: JsonObject,
  recordIndex: number,
  output: JsonObject,
  errors: FieldError[],
): void {
  const found = lookup(record, rule.sourceSegments);
  if (!found.found) return;
  const { parent, key } = ensureContainer(output, rule.targetSegments);
  placeLeaf(
    rule,
    found.value,
    recordIndex,
    null,
    (value) => {
      parent[key] = value;
    },
    errors,
  );
}

/** 将目标数组（或 null 占位）写入输出：数组值挂在数组段之前的属性上。 */
function setTargetArray(output: JsonObject, targetPrefix: PathSegment[], value: JsonValue): void {
  const propPath = targetPrefix.slice(0, -1); // 去掉末尾数组段，首段必为属性（parsePath 保证）
  const { parent, key } = ensureContainer(output, propPath);
  parent[key] = value;
}

function applyArrayGroup(
  group: ArrayGroup,
  record: JsonObject,
  recordIndex: number,
  output: JsonObject,
  errors: FieldError[],
): void {
  // 源数组定位：缺失 -> 目标缺失；null -> 目标 null；空数组 -> 目标空数组。
  const found = lookup(record, group.sourcePrefix.slice(0, -1));
  if (!found.found) return;
  if (found.value === null) {
    setTargetArray(output, group.targetPrefix, null);
    return;
  }
  if (!Array.isArray(found.value)) {
    for (const rule of group.rules) {
      errors.push({
        recordIndex,
        arrayIndex: null,
        sourcePath: rule.sourcePath,
        targetPath: rule.targetPath,
        reason: "源数组位置不是数组",
      });
    }
    return;
  }

  const sourceArray = found.value;
  const targetArray: JsonValue[] = new Array(sourceArray.length);
  for (let index = 0; index < sourceArray.length; index += 1) {
    const element = sourceArray[index]!;
    const elementOutput: JsonObject = {};
    let elementIsLeaf = false;
    let elementLeafSet = false;
    let elementLeafValue: JsonValue = null;
    for (const rule of group.rules) {
      const sourceRest = rule.sourceSegments.slice(rule.sourceArrayIndex + 1);
      const targetRest = rule.targetSegments.slice(rule.targetArrayIndex + 1);
      const leaf = lookup(element, sourceRest);
      if (!leaf.found) continue;
      if (targetRest.length === 0) {
        // 叶子即数组元素本身（每组至多一条此类规则，由定义检查保证）。
        elementIsLeaf = true;
        placeLeaf(
          rule,
          leaf.value,
          recordIndex,
          index,
          (value) => {
            elementLeafSet = true;
            elementLeafValue = value;
          },
          errors,
        );
        continue;
      }
      const { parent, key } = ensureContainer(elementOutput, targetRest);
      placeLeaf(
        rule,
        leaf.value,
        recordIndex,
        index,
        (value) => {
          parent[key] = value;
        },
        errors,
      );
    }
    // 元素没有成功字段时仍保留空对象。
    targetArray[index] = elementIsLeaf && elementLeafSet ? elementLeafValue : elementOutput;
  }
  setTargetArray(output, group.targetPrefix, targetArray);
}

/**
 * 批量转换：每条源记录恰好产生一条输出，顺序不变；数组逐元素对应。
 * 定义非法时抛出错误（可先调用 validateDefinition 检查）。
 * 不修改传入的定义与源记录；批次之间不保留任何状态。
 */
export function convertRecords(
  definition: MappingDefinition,
  records: JsonObject[],
): ConvertResult {
  const validation = validateDefinition(definition);
  if (!validation.ok) {
    throw new Error(`非法映射定义: ${validation.errors.map((e) => e.message).join("; ")}`);
  }
  const { plainRules, arrayGroups } = compileRules(definition);
  const outputs: JsonObject[] = [];
  const errors: FieldError[] = [];

  for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
    const record = records[recordIndex]!;
    const output: JsonObject = {};
    for (const rule of plainRules) {
      applyPlainRule(rule, record, recordIndex, output, errors);
    }
    for (const group of arrayGroups) {
      applyArrayGroup(group, record, recordIndex, output, errors);
    }
    outputs.push(output);
  }
  return { records: outputs, errors };
}
