import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateDocxFile } from "../src/index.ts";
import {
  buildZip,
  CONTENT_TYPES_XML,
  DOCUMENT_XML,
  docxEntries,
  ROOT_RELS_XML,
  type EntrySpec,
} from "./helpers/zipBuilder.ts";

let dir: string;
let n = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "docx-ooxml-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function check(entries: EntrySpec[]) {
  const { buf } = buildZip(entries);
  const p = join(dir, `case-${n++}.bin`);
  await writeFile(p, buf);
  return validateDocxFile(p);
}

const OFFICE_REL =
  'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"';

describe("路径规则拒收", () => {
  it("绝对路径", async () => {
    const r = await check(
      docxEntries({ extra: [{ name: "/abs.xml", data: "<x/>" }] }),
    );
    expect(r).toMatchObject({ ok: false, code: "ZIP_PATH_INVALID" });
  });

  it("反斜线", async () => {
    const r = await check(
      docxEntries({ extra: [{ name: "word\\evil.xml", data: "<x/>" }] }),
    );
    expect(r).toMatchObject({ ok: false, code: "ZIP_PATH_INVALID" });
  });

  it("空路径段", async () => {
    const r = await check(
      docxEntries({ extra: [{ name: "word//a.xml", data: "<x/>" }] }),
    );
    expect(r).toMatchObject({ ok: false, code: "ZIP_PATH_INVALID" });
  });

  it("点与双点路径段", async () => {
    const r1 = await check(
      docxEntries({ extra: [{ name: "word/./a.xml", data: "<x/>" }] }),
    );
    expect(r1).toMatchObject({ ok: false, code: "ZIP_PATH_INVALID" });
    const r2 = await check(
      docxEntries({ extra: [{ name: "word/../a.xml", data: "<x/>" }] }),
    );
    expect(r2).toMatchObject({ ok: false, code: "ZIP_PATH_INVALID" });
  });

  it("文件与目录同名", async () => {
    const r = await check(
      docxEntries({
        extra: [
          { name: "word/media", directory: true },
          { name: "word/media", data: "<x/>" },
        ],
      }),
    );
    expect(r).toMatchObject({ ok: false, code: "ZIP_DUPLICATE_PATH" });
  });

  it("重复文件路径", async () => {
    const r = await check(
      docxEntries({
        extra: [
          { name: "word/a.xml", data: "<x/>" },
          { name: "word/a.xml", data: "<y/>" },
        ],
      }),
    );
    expect(r).toMatchObject({ ok: false, code: "ZIP_DUPLICATE_PATH" });
  });
});

describe("OOXML 拒收", () => {
  it("缺少 [Content_Types].xml", async () => {
    const entries = docxEntries().filter((e) => e.name !== "[Content_Types].xml");
    const r = await check(entries);
    expect(r).toMatchObject({ ok: false, code: "OOXML_PART_MISSING" });
  });

  it("缺少 _rels/.rels", async () => {
    const entries = docxEntries().filter((e) => e.name !== "_rels/.rels");
    const r = await check(entries);
    expect(r).toMatchObject({ ok: false, code: "OOXML_PART_MISSING" });
  });

  it("[Content_Types].xml 不是有效 XML", async () => {
    const r = await check(docxEntries({ contentTypes: "<Types><broken>" }));
    expect(r).toMatchObject({ ok: false, code: "OOXML_XML_INVALID" });
  });

  it("根关系中没有 officeDocument", async () => {
    const rels = ROOT_RELS_XML.replace(OFFICE_REL, 'Type="http://example.com/other"');
    const r = await check(docxEntries({ rootRels: rels }));
    expect(r).toMatchObject({ ok: false, code: "OOXML_ROOT_REL_INVALID" });
  });

  it("根关系中有两个 officeDocument", async () => {
    const rels = ROOT_RELS_XML.replace(
      "</Relationships>",
      '  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>\n</Relationships>',
    );
    const r = await check(docxEntries({ rootRels: rels }));
    expect(r).toMatchObject({ ok: false, code: "OOXML_ROOT_REL_INVALID" });
  });

  it("officeDocument 指向外部目标", async () => {
    const rels = ROOT_RELS_XML.replace(
      'Target="word/document.xml"',
      'Target="https://evil.example/x.docx" TargetMode="External"',
    );
    const r = await check(docxEntries({ rootRels: rels }));
    expect(r).toMatchObject({ ok: false, code: "OOXML_ROOT_REL_INVALID" });
  });

  it("officeDocument 指向不存在的部件", async () => {
    const rels = ROOT_RELS_XML.replace(
      'Target="word/document.xml"',
      'Target="word/missing.xml"',
    );
    const r = await check(docxEntries({ rootRels: rels }));
    expect(r).toMatchObject({ ok: false, code: "OOXML_ROOT_REL_INVALID" });
  });

  it("officeDocument Target 越出包根", async () => {
    const rels = ROOT_RELS_XML.replace(
      'Target="word/document.xml"',
      'Target="../escape.xml"',
    );
    const r = await check(docxEntries({ rootRels: rels }));
    expect(r).toMatchObject({ ok: false, code: "OOXML_ROOT_REL_INVALID" });
  });

  it("主部件为宏文档类型", async () => {
    const ct = CONTENT_TYPES_XML.replace(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
      "application/vnd.ms-word.document.macroEnabled.main+xml",
    );
    const r = await check(docxEntries({ contentTypes: ct }));
    expect(r).toMatchObject({ ok: false, code: "OOXML_CONTENT_TYPE_INVALID" });
  });

  it("主部件为模板类型", async () => {
    const ct = CONTENT_TYPES_XML.replace(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml",
    );
    const r = await check(docxEntries({ contentTypes: ct }));
    expect(r).toMatchObject({ ok: false, code: "OOXML_CONTENT_TYPE_INVALID" });
  });

  it("主部件根元素不是 document", async () => {
    const doc = DOCUMENT_XML.replaceAll("w:document", "w:settings");
    const r = await check(docxEntries({ document: doc }));
    expect(r).toMatchObject({ ok: false, code: "OOXML_MAIN_PART_INVALID" });
  });

  it("主部件命名空间错误", async () => {
    const doc = DOCUMENT_XML.replace(
      "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
      "http://example.com/fake",
    );
    const r = await check(docxEntries({ document: doc }));
    expect(r).toMatchObject({ ok: false, code: "OOXML_MAIN_PART_INVALID" });
  });

  it("主部件含 DTD", async () => {
    const doc = DOCUMENT_XML.replace(
      "<w:document",
      `<!DOCTYPE w:document [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>\n<w:document`,
    );
    const r = await check(docxEntries({ document: doc }));
    expect(r).toMatchObject({ ok: false, code: "OOXML_XML_INVALID" });
  });

  it("主部件含未定义实体引用", async () => {
    const doc = DOCUMENT_XML.replace("hello", "&xxe;");
    const r = await check(docxEntries({ document: doc }));
    expect(r).toMatchObject({ ok: false, code: "OOXML_XML_INVALID" });
  });

  it("主部件不是有效 XML", async () => {
    const r = await check(docxEntries({ document: "<w:document" }));
    expect(r).toMatchObject({ ok: false, code: "OOXML_XML_INVALID" });
  });

  it("内容类型 Override 优先于扩展名 Default", async () => {
    // document.xml 走 Override；若误判为 Default 的 application/xml 则应拒收
    const r = await check(docxEntries());
    expect(r).toMatchObject({ ok: true });
  });

  it("主部件内容类型未声明", async () => {
    const ct = CONTENT_TYPES_XML.replace(
      /  <Override PartName="\/word\/document\.xml"[^>]*\/>\n/,
      "",
    );
    const r = await check(docxEntries({ contentTypes: ct }));
    expect(r).toMatchObject({ ok: false, code: "OOXML_CONTENT_TYPE_INVALID" });
  });
});
