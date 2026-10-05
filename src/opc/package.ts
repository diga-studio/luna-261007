import { OK, reject, type ValidationResult } from "../result.js";
import type { ZipArchive } from "../zip/reader.js";
import { getAttr, parseXml, XmlError, type XmlElement } from "../xml/parser.js";
import { resolveRelationshipTarget, validateEntryPath } from "./paths.js";

const NS_CONTENT_TYPES = "http://schemas.openxmlformats.org/package/2006/content-types";
const NS_RELATIONSHIPS = "http://schemas.openxmlformats.org/package/2006/relationships";
const NS_WML_MAIN = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const REL_OFFICE_DOCUMENT =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";
const CT_DOCX_MAIN =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";

function parseXmlPart(name: string, data: Buffer): XmlElement | ValidationResult {
  try {
    return parseXml(data).root;
  } catch (err) {
    return reject(
      "XML_INVALID",
      `${name}: ${err instanceof XmlError ? err.message : "not well-formed"}`,
    );
  }
}

function isRoot(el: XmlElement, ns: string, local: string): boolean {
  return el.namespaceUri === ns && el.localName === local;
}

export function validateOpcPackage(
  archive: ZipArchive,
  readEntry: (name: string) => Buffer,
): ValidationResult {
  const parts = new Map<string, boolean>();
  for (const entry of archive.entries) {
    if (!validateEntryPath(entry.name)) {
      return reject("ZIP_PATH_INVALID", `invalid entry path: ${entry.name}`);
    }
    const key = entry.isDirectory ? entry.name.slice(0, -1) : entry.name;
    if (parts.has(key)) {
      return reject("ZIP_PATH_INVALID", `file/directory name collision: ${key}`);
    }
    parts.set(key, entry.isDirectory);
  }

  if (parts.get("[Content_Types].xml") !== false) {
    return reject("OPC_PART_MISSING", "missing [Content_Types].xml");
  }
  if (parts.get("_rels/.rels") !== false) {
    return reject("OPC_PART_MISSING", "missing _rels/.rels");
  }

  const ctRoot = parseXmlPart("[Content_Types].xml", readEntry("[Content_Types].xml"));
  if (!("localName" in ctRoot)) return ctRoot;
  if (!isRoot(ctRoot, NS_CONTENT_TYPES, "Types")) {
    return reject("OPC_CONTENT_TYPE_INVALID", "[Content_Types].xml has wrong root element");
  }
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
  for (const child of ctRoot.children) {
    if (child.namespaceUri !== NS_CONTENT_TYPES) continue;
    const contentType = getAttr(child, "ContentType");
    if (child.localName === "Default") {
      const ext = getAttr(child, "Extension");
      if (!ext || !contentType) {
        return reject("OPC_CONTENT_TYPE_INVALID", "Default element missing attributes");
      }
      const key = ext.toLowerCase();
      if (defaults.has(key)) {
        return reject("OPC_CONTENT_TYPE_INVALID", `duplicate Default for extension: ${ext}`);
      }
      defaults.set(key, contentType);
    } else if (child.localName === "Override") {
      const partName = getAttr(child, "PartName");
      if (!partName || !partName.startsWith("/") || !contentType) {
        return reject("OPC_CONTENT_TYPE_INVALID", "Override element missing attributes");
      }
      if (overrides.has(partName)) {
        return reject("OPC_CONTENT_TYPE_INVALID", `duplicate Override for part: ${partName}`);
      }
      overrides.set(partName, contentType);
    }
  }

  const relsRoot = parseXmlPart("_rels/.rels", readEntry("_rels/.rels"));
  if (!("localName" in relsRoot)) return relsRoot;
  if (!isRoot(relsRoot, NS_RELATIONSHIPS, "Relationships")) {
    return reject("OPC_RELATIONSHIP_INVALID", "_rels/.rels has wrong root element");
  }
  const seenIds = new Set<string>();
  const officeDocTargets: string[] = [];
  for (const child of relsRoot.children) {
    if (child.namespaceUri !== NS_RELATIONSHIPS || child.localName !== "Relationship") {
      continue;
    }
    const id = getAttr(child, "Id");
    const type = getAttr(child, "Type");
    const target = getAttr(child, "Target");
    const mode = getAttr(child, "TargetMode") ?? "Internal";
    if (!id || !type || target === undefined) {
      return reject("OPC_RELATIONSHIP_INVALID", "Relationship missing required attributes");
    }
    if (seenIds.has(id)) {
      return reject("OPC_RELATIONSHIP_INVALID", `duplicate relationship Id: ${id}`);
    }
    seenIds.add(id);
    if (mode !== "Internal" && mode !== "External") {
      return reject("OPC_RELATIONSHIP_INVALID", `invalid TargetMode: ${mode}`);
    }
    if (type === REL_OFFICE_DOCUMENT) {
      if (mode === "External") {
        return reject("OPC_RELATIONSHIP_INVALID", "officeDocument target is external");
      }
      const resolved = resolveRelationshipTarget("", target);
      if (resolved === null) {
        return reject("OPC_RELATIONSHIP_INVALID", `unresolvable officeDocument target: ${target}`);
      }
      officeDocTargets.push(resolved);
    }
  }
  if (officeDocTargets.length !== 1) {
    return reject(
      "OPC_RELATIONSHIP_INVALID",
      `expected exactly one officeDocument relationship, found ${officeDocTargets.length}`,
    );
  }
  const mainPart = officeDocTargets[0]!;
  if (parts.get(mainPart) !== false) {
    return reject("OPC_PART_MISSING", `main document part not in package: ${mainPart}`);
  }

  const slashName = `/${mainPart}`;
  const mainContentType =
    overrides.get(slashName) ?? defaults.get(extensionOf(mainPart));
  if (mainContentType === undefined) {
    return reject("OPC_CONTENT_TYPE_INVALID", `no content type for main part: ${mainPart}`);
  }
  if (mainContentType !== CT_DOCX_MAIN) {
    return reject("NOT_DOCX", `main part content type is not plain DOCX: ${mainContentType}`);
  }

  const mainRoot = parseXmlPart(mainPart, readEntry(mainPart));
  if (!("localName" in mainRoot)) return mainRoot;
  if (!isRoot(mainRoot, NS_WML_MAIN, "document")) {
    return reject("NOT_DOCX", "main part root is not w:document in WordprocessingML namespace");
  }

  return OK;
}

function extensionOf(partName: string): string {
  const slash = partName.lastIndexOf("/");
  const dot = partName.lastIndexOf(".");
  return dot > slash ? partName.slice(dot + 1).toLowerCase() : "";
}
