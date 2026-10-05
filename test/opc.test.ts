import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateDocx, type ValidationResult } from "../src/index.js";
import { buildZip, type EntrySpec } from "./helpers/zip.js";
import {
  docxEntries,
  contentTypesXml,
  rootRelsXml,
  DOCUMENT_XML,
  CT_MAIN,
  REL_OFFICE_DOC,
} from "./helpers/docx.js";

const dir = mkdtempSync(join(tmpdir(), "docx-opc-"));
let counter = 0;

async function check(buf: Buffer): Promise<ValidationResult> {
  const file = join(dir, `sample-${counter++}.bin`);
  writeFileSync(file, buf);
  return validateDocx(file);
}

async function expectOk(buf: Buffer): Promise<void> {
  const res = await check(buf);
  assert.equal(res.ok, true, res.ok ? "" : `${res.code}: ${res.message}`);
}

async function expectReject(buf: Buffer, code: string): Promise<void> {
  const res = await check(buf);
  assert.equal(res.ok, false, "expected rejection");
  if (!res.ok) assert.equal(res.code, code, res.message);
}

test.after(() => rmSync(dir, { recursive: true, force: true }));

const CT_MACRO = "application/vnd.ms-word.document.macroEnabled.main+xml";
const CT_TEMPLATE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml";

// ---------- required parts ----------

test("reject: missing [Content_Types].xml", async () => {
  const entries = docxEntries().filter((e) => e.name !== "[Content_Types].xml");
  await expectReject(buildZip(entries), "OPC_PART_MISSING");
});

test("reject: missing _rels/.rels", async () => {
  const entries = docxEntries().filter((e) => e.name !== "_rels/.rels");
  await expectReject(buildZip(entries), "OPC_PART_MISSING");
});

test("reject: case-variant of required parts does not count", async () => {
  const entries: EntrySpec[] = docxEntries().map((e) =>
    e.name === "_rels/.rels" ? { ...e, name: "_RELS/.rels" } : e,
  );
  await expectReject(buildZip(entries), "OPC_PART_MISSING");
});

// ---------- root relationships ----------

test("reject: no officeDocument relationship", async () => {
  await expectReject(
    buildZip(docxEntries({ rootRels: rootRelsXml([{ type: "http://example.com/other" }]) })),
    "OPC_RELATIONSHIP_INVALID",
  );
});

test("reject: two officeDocument relationships", async () => {
  await expectReject(
    buildZip(
      docxEntries({
        rootRels: rootRelsXml([{ target: "word/document.xml" }, { target: "word/document.xml" }]),
      }),
    ),
    "OPC_RELATIONSHIP_INVALID",
  );
});

test("reject: external officeDocument target", async () => {
  await expectReject(
    buildZip(
      docxEntries({
        rootRels: rootRelsXml([{ target: "http://evil.example/x.docx", mode: "External" }]),
      }),
    ),
    "OPC_RELATIONSHIP_INVALID",
  );
});

test("reject: officeDocument target with URI scheme", async () => {
  await expectReject(
    buildZip(docxEntries({ rootRels: rootRelsXml([{ target: "file:///etc/passwd" }]) })),
    "OPC_RELATIONSHIP_INVALID",
  );
});

test("reject: officeDocument target escapes package root", async () => {
  await expectReject(
    buildZip(docxEntries({ rootRels: rootRelsXml([{ target: "../evil.xml" }]) })),
    "OPC_RELATIONSHIP_INVALID",
  );
});

test("reject: percent-encoded target escapes package root", async () => {
  await expectReject(
    buildZip(docxEntries({ rootRels: rootRelsXml([{ target: "%2e%2e/evil.xml" }]) })),
    "OPC_RELATIONSHIP_INVALID",
  );
});

test("reject: officeDocument target part not in package", async () => {
  await expectReject(
    buildZip(docxEntries({ rootRels: rootRelsXml([{ target: "word/missing.xml" }]) })),
    "OPC_PART_MISSING",
  );
});

test("reject: duplicate relationship Id", async () => {
  await expectReject(
    buildZip(
      docxEntries({
        rootRels: rootRelsXml([
          { id: "rId1", target: "word/document.xml" },
          { id: "rId1", type: "http://example.com/other", target: "word/document.xml" },
        ]),
      }),
    ),
    "OPC_RELATIONSHIP_INVALID",
  );
});

test("reject: _rels/.rels with wrong root namespace", async () => {
  const bad = `<?xml version="1.0"?><Relationships xmlns="http://example.com/wrong"><Relationship Id="rId1" Type="${REL_OFFICE_DOC}" Target="word/document.xml"/></Relationships>`;
  await expectReject(buildZip(docxEntries({ rootRels: bad })), "OPC_RELATIONSHIP_INVALID");
});

// ---------- content types ----------

test("reject: macro-enabled main content type", async () => {
  await expectReject(
    buildZip(docxEntries({ contentTypes: contentTypesXml([["/word/document.xml", CT_MACRO]]) })),
    "NOT_DOCX",
  );
});

test("reject: template main content type", async () => {
  await expectReject(
    buildZip(docxEntries({ contentTypes: contentTypesXml([["/word/document.xml", CT_TEMPLATE]]) })),
    "NOT_DOCX",
  );
});

test("reject: no content type declared for main part", async () => {
  await expectReject(
    buildZip(docxEntries({
        contentTypes: contentTypesXml([], [["rels", "application/vnd.openxmlformats-package.relationships+xml"]]),
      })),
    "OPC_CONTENT_TYPE_INVALID",
  );
});

test("ok: Override beats wrong Default for main part", async () => {
  await expectOk(
    buildZip(
      docxEntries({
        contentTypes: contentTypesXml(
          [["/word/document.xml", CT_MAIN]],
          [
            ["rels", "application/vnd.openxmlformats-package.relationships+xml"],
            ["xml", CT_MACRO],
          ],
        ),
      }),
    ),
  );
});

test("reject: Override reclassifies main part as macro", async () => {
  await expectReject(
    buildZip(
      docxEntries({
        contentTypes: contentTypesXml(
          [["/word/document.xml", CT_MACRO]],
          [
            ["rels", "application/vnd.openxmlformats-package.relationships+xml"],
            ["xml", CT_MAIN],
          ],
        ),
      }),
    ),
    "NOT_DOCX",
  );
});

test("reject: [Content_Types].xml with wrong root element", async () => {
  const bad = `<?xml version="1.0"?><Types xmlns="http://example.com/wrong"/>`;
  await expectReject(buildZip(docxEntries({ contentTypes: bad })), "OPC_CONTENT_TYPE_INVALID");
});

// ---------- main part XML ----------

test("reject: main part is a spreadsheet", async () => {
  const sheet = `<?xml version="1.0"?><s:worksheet xmlns:s="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>`;
  await expectReject(buildZip(docxEntries({ mainXml: sheet })), "NOT_DOCX");
});

test("reject: w:document local name in wrong namespace", async () => {
  const bad = `<?xml version="1.0"?><w:document xmlns:w="http://example.com/not-wml"/>`;
  await expectReject(buildZip(docxEntries({ mainXml: bad })), "NOT_DOCX");
});

test("ok: document root with non-w prefix but correct namespace", async () => {
  const good = `<?xml version="1.0"?><w0:document xmlns:w0="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w0:body/></w0:document>`;
  await expectOk(buildZip(docxEntries({ mainXml: good })));
});

test("ok: main part at package root", async () => {
  await expectOk(buildZip(docxEntries({ mainPart: "document.xml" })));
});

// ---------- XML safety ----------

test("reject: DTD in main part", async () => {
  const dtd = `<?xml version="1.0"?><!DOCTYPE w:document [<!ENTITY x "y">]><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>`;
  await expectReject(buildZip(docxEntries({ mainXml: dtd })), "XML_INVALID");
});

test("reject: external entity in _rels/.rels", async () => {
  const evil = `<?xml version="1.0"?><!DOCTYPE Relationships [<!ENTITY e SYSTEM "file:///etc/passwd">]><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL_OFFICE_DOC}" Target="word/document.xml"/></Relationships>`;
  await expectReject(buildZip(docxEntries({ rootRels: evil })), "XML_INVALID");
});

test("reject: malformed XML in [Content_Types].xml", async () => {
  await expectReject(buildZip(docxEntries({ contentTypes: "<Types><unclosed>" })), "XML_INVALID");
});

test("reject: UTF-16 encoded main part", async () => {
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(DOCUMENT_XML, "utf16le")]);
  const entries = docxEntries().map((e) => (e.name === "word/document.xml" ? { ...e, data: utf16 } : e));
  await expectReject(buildZip(entries), "XML_INVALID");
});

test("reject: undeclared namespace prefix in main part", async () => {
  const bad = `<?xml version="1.0"?><w:document><w:body/></w:document>`;
  await expectReject(buildZip(docxEntries({ mainXml: bad })), "XML_INVALID");
});

// ---------- IO ----------

test("reject: nonexistent input file", async () => {
  const res = await validateDocx(join(dir, "does-not-exist.bin"));
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, "IO_ERROR");
});
