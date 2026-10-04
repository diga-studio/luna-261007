import type { JsonValue, QueryParams, Template } from "./types";

const PLACEHOLDER = /\{\{([^{}]+)\}\}/g;

function substitute(text: string, template: Template, params: QueryParams): string {
  return text.replace(PLACEHOLDER, (raw, name: string) => {
    const key = name.trim();
    const declared = Object.prototype.hasOwnProperty.call(template.tokens, key);
    if (!declared) return raw;
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      return params[key] as string;
    }
    return template.tokens[key]!.default;
  });
}

function walk(value: JsonValue, template: Template, params: QueryParams): JsonValue {
  if (typeof value === "string") return substitute(value, template, params);
  if (Array.isArray(value)) return value.map((item) => walk(item, template, params));
  if (value !== null && typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = walk(child, template, params);
    }
    return out;
  }
  return value;
}

/**
 * 对模板区块执行全量占位符替换（纯函数）。
 * - 只替换字符串叶值中的 {{token}}；键名与非字符串值保持不变。
 * - 同名查询参数优先（空字符串是有效值），缺失时用 token 默认值。
 * - String.prototype.replace 的替换值不会被再次扫描，因此替换值不会被二次解释。
 */
export function renderTemplate(template: Template, params: QueryParams): JsonValue {
  return walk(template.blocks, template, params);
}
