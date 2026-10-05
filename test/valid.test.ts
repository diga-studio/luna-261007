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

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "docx-valid-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function check(entries: EntrySpec[], fileName = "case.bin") {
  const { buf } = buildZip(entries);
  const p = join(dir, fileName);
  await writeFile(p, buf);
  return validateDocxFile(p);
}

describe("合法场景", () => {
  it("标准 DOCX（deflate，无描述符）", async () => {
    const r = await check(docxEntries(), "standard.anything");
    expect(r).toMatchObject({ ok: true, mainPart: "word/document.xml" });
  });

  it("文件名与扩展名不参与判定", async () => {
    const { buf } = buildZip(docxEntries());
    const p = join(dir, "not-a-docx.txt");
    await writeFile(p, buf);
    const r = await validateDocxFile(p);
    expect(r.ok).toBe(true);
  });

  it("主部件换目录（相对 Target）", async () => {
    const ct = CONTENT_TYPES_XML.replace(
      "/word/document.xml",
      "/custom/dir/main.xml",
    );
    const rels = ROOT_RELS_XML.replace(
      'Target="word/document.xml"',
      'Target="custom/dir/main.xml"',
    );
    const r = await check(
      docxEntries({
        contentTypes: ct,
        rootRels: rels,
        documentPath: "custom/dir/main.xml",
      }),
    );
    expect(r).toMatchObject({ ok: true, mainPart: "custom/dir/main.xml" });
  });

  it("根关系 Target 为包内绝对路径", async () => {
    const rels = ROOT_RELS_XML.replace(
      'Target="word/document.xml"',
      'Target="/word/document.xml"',
    );
    const r = await check(docxEntries({ rootRels: rels }));
    expect(r.ok).toBe(true);
  });

  it("Target 含百分号转义与点段", async () => {
    const rels = ROOT_RELS_XML.replace(
      'Target="word/document.xml"',
      'Target="word/../%77ord/document.xml"',
    );
    const r = await check(docxEntries({ rootRels: rels }));
    expect(r.ok).toBe(true);
  });

  it("Stored 条目与带签名的数据描述符", async () => {
    const r = await check(
      docxEntries({
        extra: [
          { name: "word/styles.xml", data: "<x/>", method: 0 },
          { name: "docProps/core.xml", data: "<x/>", descriptor: "sig" },
        ],
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("Deflate 条目与不带签名的数据描述符", async () => {
    const r = await check(
      docxEntries({
        extra: [
          { name: "docProps/app.xml", data: "<x/>", descriptor: "nosig" },
        ],
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("UTF-8 名称条目（带 UTF-8 标志）", async () => {
    const r = await check(
      docxEntries({
        extra: [{ name: "word/注释.xml", data: "<x/>", utf8: true }],
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("显式目录条目", async () => {
    const r = await check(
      docxEntries({
        extra: [{ name: "word/media", directory: true }],
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("EOCD 带注释", async () => {
    const { buf } = buildZip(docxEntries(), { comment: "archive comment" });
    const p = join(dir, "commented.bin");
    await writeFile(p, buf);
    const r = await validateDocxFile(p);
    expect(r.ok).toBe(true);
  });

  it("主部件使用默认前缀以外的命名空间前缀", async () => {
    const doc = DOCUMENT_XML.replaceAll("w:", "x:").replace(
      'xmlns:x="',
      'xmlns:x="',
    ).replace("xmlns:w=", "xmlns:x=");
    const r = await check(docxEntries({ document: doc }));
    expect(r.ok).toBe(true);
  });
});
