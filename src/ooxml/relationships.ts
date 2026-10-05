import type { XmlElement } from "../xml.ts";

export const ROOT_RELS_PART = "_rels/.rels";
export const RELATIONSHIPS_NS =
  "http://schemas.openxmlformats.org/package/2006/relationships";
export const OFFICE_DOCUMENT_REL_TYPE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";

export class RelationshipsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelationshipsError";
  }
}

export interface Relationship {
  id: string;
  type: string;
  /** 原始 Target 字符串（未解码）。 */
  rawTarget: string;
  /** TargetMode 属性值；为 "External" 时表示外部目标。 */
  targetMode: string | null;
}

function attr(el: XmlElement, localName: string): string | undefined {
  return el.attributes.find((a) => a.ns === "" && a.localName === localName)
    ?.value;
}

/** 解析 .rels 部件为关系列表。 */
export function parseRelationships(root: XmlElement): Relationship[] {
  if (root.ns !== RELATIONSHIPS_NS || root.localName !== "Relationships") {
    throw new RelationshipsError(".rels 根元素不是 Relationships");
  }
  const rels: Relationship[] = [];
  const ids = new Set<string>();
  for (const child of root.children) {
    if (child.ns !== RELATIONSHIPS_NS || child.localName !== "Relationship") {
      continue;
    }
    const id = attr(child, "Id");
    const type = attr(child, "Type");
    const target = attr(child, "Target");
    if (!id || !type || target === undefined) {
      throw new RelationshipsError("Relationship 缺少 Id/Type/Target");
    }
    if (ids.has(id)) {
      throw new RelationshipsError(`重复的关系 Id: ${id}`);
    }
    ids.add(id);
    rels.push({
      id,
      type,
      rawTarget: target,
      targetMode: attr(child, "TargetMode") ?? null,
    });
  }
  return rels;
}

function percentDecodeUtf8(target: string): string | null {
  const bytes: number[] = [];
  for (let i = 0; i < target.length; i++) {
    const ch = target[i]!;
    if (ch === "%") {
      const hex = target.slice(i + 1, i + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return null;
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(...new TextEncoder().encode(ch));
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      new Uint8Array(bytes),
    );
  } catch {
    return null;
  }
}

/**
 * 将关系 Target 解析为包内绝对路径（以 "/" 开头）。
 * sourceDir 为关系来源部件所在目录（包内绝对路径，根为 "/"）。
 * 百分号转义按 UTF-8 解码一次后再解析 "." / ".." 段。
 * 解码失败或越出包根时返回 null。
 */
export function resolveRelationshipTarget(
  sourceDir: string,
  target: string,
): string | null {
  const decoded = percentDecodeUtf8(target);
  if (decoded === null) return null;
  const segments: string[] = [];
  if (!decoded.startsWith("/")) {
    for (const seg of sourceDir.split("/")) {
      if (seg !== "") segments.push(seg);
    }
  }
  for (const seg of decoded.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(seg);
  }
  if (segments.length === 0) return null;
  return "/" + segments.join("/");
}
