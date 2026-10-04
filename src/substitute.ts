import type { QueryParams, TemplateBlock, TemplateContent } from "./types.js";
import type { JsonValue } from "./types.js";

const PLACEHOLDER = /\{\{\s*([^{}\s][^{}]*?)\s*\}\}/g;

function substituteString(value: string, resolve: (token: string) => string | undefined): string {
  return value.replace(PLACEHOLDER, (match, token: string) => {
    const resolved = resolve(token);
    return resolved === undefined ? match : resolved;
  });
}

function substituteValue(value: JsonValue, resolve: (token: string) => string | undefined): JsonValue {
  if (typeof value === "string") {
    return substituteString(value, resolve);
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteValue(item, resolve));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const key of Object.keys(value)) {
      out[key] = substituteValue(value[key], resolve);
    }
    return out;
  }
  return value;
}

/**
 * Replace every {{token}} placeholder in all string leaf values of the
 * template blocks. Query params win over token defaults; an empty string
 * is a valid value. Replacement text is never re-scanned for placeholders.
 * Keys and non-string values are preserved as-is.
 */
export function renderTemplate(
  content: TemplateContent,
  params: QueryParams,
): TemplateBlock {
  const resolve = (token: string): string | undefined => {
    if (Object.prototype.hasOwnProperty.call(params, token)) {
      return params[token];
    }
    if (Object.prototype.hasOwnProperty.call(content.tokens, token)) {
      return content.tokens[token];
    }
    return undefined;
  };
  return substituteValue(content.blocks, resolve) as TemplateBlock;
}
