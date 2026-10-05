import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateDocxFile } from "../src/index.ts";
import { buildZip, docxEntries, type EntrySpec } from "./helpers/zipBuilder.ts";

let dir: string;
let n = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "docx-zip-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function checkBuf(buf: Uint8Array) {
  const p = join(dir, `case-${n++}.bin`);
  await writeFile(p, buf);
  return validateDocxFile(p);
}

async function check(entries: EntrySpec[], opts: Parameters<typeof buildZip>[1] = {}) {
  return checkBuf(buildZip(entries, opts).buf);
}

describe("ZIP 结构拒收", () => {
  it("非 ZIP 文件", async () => {
    const r = await checkBuf(new TextEncoder().encode("not a zip file at all, just text"));
    expect(r).toMatchObject({ ok: false, code: "NOT_ZIP" });
  });

  it("中央目录与本地头矛盾（CRC）", async () => {
    const r = await check(
      docxEntries({
        extra: [{ name: "word/styles.xml", data: "<x/>", local: { crc: 0xdeadbeef } }],
      }),
    );
    expect(r).toMatchObject({ ok: false, code: "ZIP_ENTRY_MISMATCH" });
  });

  it("中央目录与本地头矛盾（压缩方式）", async () => {
    const r = await check(
      docxEntries({
        extra: [{ name: "word/styles.xml", data: "<x/>", method: 8, cd: { method: 0 } }],
      }),
    );
    expect(r).toMatchObject({ ok: false, code: "ZIP_ENTRY_MISMATCH" });
  });

  it("中央目录与本地头矛盾（名称）", async () => {
    const { buf, localOffsets } = buildZip(docxEntries());
    // 篡改 "[Content_Types].xml" 本地头名称首字节（保持长度一致）
    const off = localOffsets[0]! + 30;
    buf[off] = "X".charCodeAt(0);
    const r = await checkBuf(buf);
    expect(r).toMatchObject({ ok: false, code: "ZIP_ENTRY_MISMATCH" });
  });

  it("数据描述符与中央目录矛盾", async () => {
    const { buf } = buildZip(
      docxEntries({
        extra: [{ name: "docProps/app.xml", data: "<x/>", descriptor: "sig" }],
      }),
    );
    // 找到描述符签名并篡改其 CRC
    const sig = [0x50, 0x4b, 0x07, 0x08];
    let idx = -1;
    for (let i = 0; i < buf.length - 4; i++) {
      if (sig.every((b, j) => buf[i + j] === b)) { idx = i; break; }
    }
    expect(idx).toBeGreaterThan(-1);
    buf[idx + 4] = buf[idx + 4]! ^ 0xff;
    const r = await checkBuf(buf);
    expect(r).toMatchObject({ ok: false, code: "ZIP_ENTRY_MISMATCH" });
  });

  it("条目 CRC 错误", async () => {
    const r = await check(
      docxEntries({
        extra: [{ name: "word/styles.xml", data: "<x/>", cd: { crc: 12345 }, local: { crc: 12345 } }],
      }),
    );
    expect(r).toMatchObject({ ok: false, code: "ZIP_ENTRY_CRC_MISMATCH" });
  });

  it("解压长度与声明不符", async () => {
    const r = await check(
      docxEntries({
        extra: [
          {
            name: "word/styles.xml",
            data: "<x></x>",
            cd: { uncompSize: 999 },
            local: { uncompSize: 999 },
          },
        ],
      }),
    );
    expect(r).toMatchObject({ ok: false, code: "ZIP_ENTRY_SIZE_MISMATCH" });
  });

  it("ZIP64 标记", async () => {
    const r = await check(docxEntries(), {
      eocdPatch: (eocd) => {
        // entriesTotal 置为 0xffff
        eocd[10] = 0xff;
        eocd[11] = 0xff;
      },
    });
    expect(r).toMatchObject({ ok: false, code: "ZIP_UNSUPPORTED_FEATURE" });
  });

  it("加密条目", async () => {
    const r = await check(
      docxEntries({
        extra: [{ name: "word/styles.xml", data: "<x/>", cd: { flags: 0x0801 }, local: { flags: 0x0801 } }],
      }),
    );
    expect(r).toMatchObject({ ok: false, code: "ZIP_UNSUPPORTED_FEATURE" });
  });

  it("不支持的压缩方式", async () => {
    const r = await check(
      docxEntries({
        extra: [{ name: "word/styles.xml", data: "<x/>", cd: { method: 99 }, local: { method: 99 } }],
      }),
    );
    expect(r).toMatchObject({ ok: false, code: "ZIP_UNSUPPORTED_FEATURE" });
  });

  it("前置数据", async () => {
    const r = await check(docxEntries(), { prefix: new Uint8Array([1, 2, 3]) });
    expect(r).toMatchObject({ ok: false, code: "ZIP_STRUCTURE_INVALID" });
  });

  it("拼接归档（EOCD 后多余字节）", async () => {
    const r = await check(docxEntries(), {
      comment: "abc",
      suffix: new Uint8Array([9, 9]),
    });
    expect(r).toMatchObject({ ok: false, code: "NOT_ZIP" });
  });

  it("未列入中央目录的本地条目", async () => {
    const r = await check(docxEntries(), {
      orphanLocal: { name: "word/orphan.xml", data: "<x/>" },
    });
    expect(r).toMatchObject({ ok: false, code: "ZIP_STRUCTURE_INVALID" });
  });

  it("中央目录与 EOCD 之间的夹带数据", async () => {
    const r = await check(docxEntries(), {
      betweenCdAndEocd: new Uint8Array([0, 0]),
    });
    expect(r).toMatchObject({ ok: false, code: "ZIP_STRUCTURE_INVALID" });
  });

  it("条目范围重叠", async () => {
    const r = await check(
      docxEntries({
        extra: [{ name: "word/a.xml", data: "<x/>", cd: { localHeaderOffset: 0 } }],
      }),
    );
    expect(r).toMatchObject({ ok: false, code: "ZIP_ENTRY_OVERLAP" });
  });

  it("非 ASCII 名称未声明 UTF-8", async () => {
    const r = await check(
      docxEntries({
        extra: [
          {
            name: "word/x.xml",
            data: "<x/>",
            rawNameBytes: new Uint8Array([0xe6, 0x97, 0xa5, 0x2e, 0x78, 0x6d, 0x6c]),
          },
        ],
      }),
    );
    expect(r).toMatchObject({ ok: false, code: "ZIP_NAME_INVALID" });
  });
});
