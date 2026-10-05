import { fail, type ValidationResult } from "../types.ts";
import { parseXml, XmlError } from "../xml.ts";
import type { ZipArchive } from "../zip/types.ts";
import {
  buildContentTypeResolver,
  ContentTypeError,
  CONTENT_TYPES_PART,
  DOCX_MAIN_CONTENT_TYPE,
} from "./contentTypes.ts";
import {
  OFFICE_DOCUMENT_REL_TYPE,
  parseRelationships,
  RelationshipsError,
  resolveRelationshipTarget,
  ROOT_RELS_PART,
} from "./relationships.ts";

const WML_MAIN_NS =
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

function parsePartXml(partName: string, data: Uint8Array) {
  try {
    return parseXml(data);
  } catch (err) {
    if (err instanceof XmlError) {
      return fail("OOXML_XML_INVALID", `部件 ${partName} 不是有效 XML: ${err.message}`);
    }
    throw err;
  }
}

/** 在 ZIP 结构校验通过后，执行 OOXML/OPC 层面的入库校验。 */
export function validateOoxmlPackage(archive: ZipArchive): ValidationResult {
  const parts = new Map<string, Uint8Array>();
  for (const entry of archive.entries) {
    if (!entry.isDirectory) parts.set(entry.name, entry.data);
  }

  const contentTypesData = parts.get(CONTENT_TYPES_PART);
  if (!contentTypesData) {
    return fail("OOXML_PART_MISSING", `缺少必需部件 ${CONTENT_TYPES_PART}`);
  }
  const rootRelsData = parts.get(ROOT_RELS_PART);
  if (!rootRelsData) {
    return fail("OOXML_PART_MISSING", `缺少必需部件 ${ROOT_RELS_PART}`);
  }

  const contentTypesRoot = parsePartXml(CONTENT_TYPES_PART, contentTypesData);
  if ("ok" in contentTypesRoot) return contentTypesRoot;
  let resolveContentType: (partName: string) => string | undefined;
  try {
    resolveContentType = buildContentTypeResolver(contentTypesRoot);
  } catch (err) {
    if (err instanceof ContentTypeError) {
      return fail("OOXML_CONTENT_TYPE_INVALID", err.message);
    }
    throw err;
  }

  const rootRelsRoot = parsePartXml(ROOT_RELS_PART, rootRelsData);
  if ("ok" in rootRelsRoot) return rootRelsRoot;
  let rels;
  try {
    rels = parseRelationships(rootRelsRoot);
  } catch (err) {
    if (err instanceof RelationshipsError) {
      return fail("OOXML_ROOT_REL_INVALID", err.message);
    }
    throw err;
  }

  const officeRels = rels.filter((r) => r.type === OFFICE_DOCUMENT_REL_TYPE);
  if (officeRels.length !== 1) {
    return fail(
      "OOXML_ROOT_REL_INVALID",
      `根关系中 officeDocument 关系数量必须为 1，实际为 ${officeRels.length}`,
    );
  }
  const officeRel = officeRels[0]!;
  if (officeRel.targetMode === "External") {
    return fail("OOXML_ROOT_REL_INVALID", "officeDocument 关系指向外部目标");
  }
  const mainPartAbs = resolveRelationshipTarget("/", officeRel.rawTarget);
  if (mainPartAbs === null) {
    return fail(
      "OOXML_ROOT_REL_INVALID",
      `officeDocument 关系目标无法解析或越出包根: ${officeRel.rawTarget}`,
    );
  }
  const mainPart = mainPartAbs.slice(1);
  const mainData = parts.get(mainPart);
  if (!mainData) {
    return fail(
      "OOXML_ROOT_REL_INVALID",
      `officeDocument 关系指向不存在的部件: ${mainPart}`,
    );
  }

  const mainContentType = resolveContentType(mainPart);
  if (mainContentType !== DOCX_MAIN_CONTENT_TYPE) {
    return fail(
      "OOXML_CONTENT_TYPE_INVALID",
      `主部件内容类型不是普通 DOCX 正文类型: ${mainContentType ?? "(未声明)"}`,
    );
  }

  const mainRoot = parsePartXml(mainPart, mainData);
  if ("ok" in mainRoot) return mainRoot;
  if (mainRoot.ns !== WML_MAIN_NS || mainRoot.localName !== "document") {
    return fail(
      "OOXML_MAIN_PART_INVALID",
      "主部件根元素不是 WordprocessingML 的 document",
    );
  }

  return { ok: true, mainPart, entryCount: archive.entries.length };
}
