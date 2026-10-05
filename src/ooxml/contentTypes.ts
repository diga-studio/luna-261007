import type { XmlElement } from "../xml.ts";

export const CONTENT_TYPES_PART = "[Content_Types].xml";
export const CONTENT_TYPES_NS =
  "http://schemas.openxmlformats.org/package/2006/content-types";
export const DOCX_MAIN_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";

export class ContentTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContentTypeError";
  }
}

function attr(el: XmlElement, localName: string): string | undefined {
  return el.attributes.find((a) => a.ns === "" && a.localName === localName)
    ?.value;
}

/**
 * 解析 [Content_Types].xml，返回按路径确定内容类型的查询函数。
 * 规则：按路径的 Override 优先于按扩展名的 Default。
 */
export function buildContentTypeResolver(
  root: XmlElement,
): (partName: string) => string | undefined {
  if (root.ns !== CONTENT_TYPES_NS || root.localName !== "Types") {
    throw new ContentTypeError("[Content_Types].xml 根元素不是 Types");
  }
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
  for (const child of root.children) {
    if (child.ns !== CONTENT_TYPES_NS) continue;
    if (child.localName === "Default") {
      const ext = attr(child, "Extension");
      const ct = attr(child, "ContentType");
      if (!ext || !ct) {
        throw new ContentTypeError("Default 缺少 Extension 或 ContentType");
      }
      defaults.set(ext.toLowerCase(), ct);
    } else if (child.localName === "Override") {
      const part = attr(child, "PartName");
      const ct = attr(child, "ContentType");
      if (!part || !ct || !part.startsWith("/")) {
        throw new ContentTypeError("Override 缺少合法的 PartName 或 ContentType");
      }
      overrides.set(part, ct);
    }
  }
  return (partName: string): string | undefined => {
    const byPath = overrides.get("/" + partName);
    if (byPath !== undefined) return byPath;
    const dot = partName.lastIndexOf(".");
    if (dot === -1) return undefined;
    return defaults.get(partName.slice(dot + 1).toLowerCase());
  };
}
