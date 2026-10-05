import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { validateDocx, type ValidationResult } from "../src/index.js";
import { buildZip, type EntrySpec } from "./helpers/zip.js";
import { docxEntries, contentTypesXml, rootRelsXml, DOCUMENT_XML } from "./helpers/docx.js";
import { crc32 } from "../src/zip/crc32.js";

const dir = mkdtempSync(join(tmpdir(), "docx-val-"));
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

// ---------- valid containers ----------

test("valid minimal docx (deflate)", async () => {
  await expectOk(buildZip(docxEntries()));
});

test("valid docx with stored entries", async () => {
  await expectOk(buildZip(docxEntries({ transform: (es) => es.map((e) => ({ ...e, method: 0 })) })));
});

test("valid docx with data descriptor (with signature)", async () => {
  await expectOk(
    buildZip(docxEntries({ transform: (es) => es.map((e) => ({ ...e, useDataDescriptor: true })) })),
  );
});

test("valid docx with data descriptor (no signature)", async () => {
  await expectOk(
    buildZip(
      docxEntries({
        transform: (es) =>
          es.map((e) => ({ ...e, useDataDescriptor: true, descriptorWithSignature: false })),
      }),
    ),
  );
});

test("valid docx with UTF-8 flagged entry name", async () => {
  await expectOk(
    buildZip(
      docxEntries({ extraEntries: [{ name: "word/注释.txt", data: "x", utf8Flag: true }] }),
    ),
  );
});

test("valid docx with explicit directory entries", async () => {
  await expectOk(
    buildZip(
      docxEntries({
        transform: (es) => [es[0]!, { name: "_rels/", method: 0 }, { name: "word/", method: 0 }, ...es.slice(1)],
      }),
    ),
  );
});

test("valid docx with EOCD comment", async () => {
  await expectOk(buildZip(docxEntries(), { comment: "created by test" }));
});

test("valid docx with main part in custom directory", async () => {
  await expectOk(buildZip(docxEntries({ mainPart: "pkg/body/main-part.xml" })));
});

test("valid docx with absolute relationship target", async () => {
  await expectOk(
    buildZip(docxEntries({ rootRels: rootRelsXml([{ target: "/word/document.xml" }]) })),
  );
});

test("valid docx with percent-encoded and dot-segment target", async () => {
  await expectOk(
    buildZip(
      docxEntries({
        mainPart: "word/document.xml",
        rootRels: rootRelsXml([{ target: "word/../%77ord/document.xml" }]),
      }),
    ),
  );
});

test("file name and extension are irrelevant", async () => {
  const file = join(dir, "definitely-not-a-docx.txt");
  writeFileSync(file, buildZip(docxEntries()));
  const res = await validateDocx(file);
  assert.equal(res.ok, true, res.ok ? "" : `${res.code}: ${res.message}`);
});

// ---------- zip structure attacks ----------

test("reject: central directory CRC contradicts local header", async () => {
  const buf = buildZip(
    docxEntries({
      transform: (es) =>
        es.map((e, i) => {
          if (i !== 2) return e;
          const real = crc32(Buffer.from(String(e.data)));
          return { ...e, central: { crc: (real ^ 1) >>> 0 } };
        }),
    }),
  );
  await expectReject(buf, "ZIP_STRUCTURE_INVALID");
});

test("reject: central directory size contradicts local header", async () => {
  const buf = buildZip(
    docxEntries({
      transform: (es) => es.map((e, i) => (i === 0 ? { ...e, central: { compressedSize: 1 } } : e)),
    }),
  );
  await expectReject(buf, "ZIP_STRUCTURE_INVALID");
});

test("reject: local header name differs from central directory", async () => {
  const buf = buildZip(
    docxEntries({
      transform: (es) =>
        es.map((e, i) => (i === 2 ? { ...e, local: { name: "word/documenz.xml" } } : e)),
    }),
  );
  await expectReject(buf, "ZIP_STRUCTURE_INVALID");
});

test("reject: local header CRC differs from central (no descriptor)", async () => {
  const buf = buildZip(
    docxEntries({
      transform: (es) => es.map((e, i) => (i === 1 ? { ...e, local: { crc: 0xdeadbeef } } : e)),
    }),
  );
  await expectReject(buf, "ZIP_STRUCTURE_INVALID");
});

test("reject: data descriptor values contradict central directory", async () => {
  const good = docxEntries({
    transform: (es) => es.map((e) => ({ ...e, useDataDescriptor: true })),
  });
  const buf = buildZip(good);
  // corrupt the CRC inside the first data descriptor
  const idx = buf.indexOf(Buffer.from([0x50, 0x4b, 0x07, 0x08]));
  assert.ok(idx > 0);
  buf[idx + 4]! ^= 0xff;
  await expectReject(buf, "ZIP_STRUCTURE_INVALID");
});

test("reject: corrupted entry content (CRC mismatch on extract)", async () => {
  const buf = buildZip(docxEntries());
  // flip a byte inside the first entry's compressed data (offset 30 + name len)
  const nameLen = buf.readUInt16LE(26);
  buf[30 + nameLen]! ^= 0xff;
  await expectReject(buf, "ZIP_ENTRY_CORRUPT");
});

test("reject: prefix data before archive (SFX stub)", async () => {
  const buf = buildZip(docxEntries(), { prefix: Buffer.from("MZ fake stub....") });
  await expectReject(buf, "ZIP_STRUCTURE_INVALID");
});

test("reject: trailing garbage after EOCD comment", async () => {
  const buf = buildZip(docxEntries(), { suffix: Buffer.from("junk") });
  await expectReject(buf, "NOT_ZIP");
});

test("reject: concatenated archives", async () => {
  const a = buildZip(docxEntries());
  const b = buildZip(docxEntries());
  await expectReject(Buffer.concat([a, b]), "ZIP_STRUCTURE_INVALID");
});

test("reject: local entry not listed in central directory", async () => {
  const plain = Buffer.from("ghost");
  const compressed = deflateRawSync(plain);
  const name = Buffer.from("ghost.txt");
  const rec = Buffer.alloc(30);
  rec.writeUInt32LE(0x04034b50, 0);
  rec.writeUInt16LE(20, 4);
  rec.writeUInt16LE(8, 8);
  rec.writeUInt32LE(crc32(plain), 14);
  rec.writeUInt32LE(compressed.length, 18);
  rec.writeUInt32LE(plain.length, 22);
  rec.writeUInt16LE(name.length, 26);
  const buf = buildZip(docxEntries(), {
    extraLocalRecords: Buffer.concat([rec, name, compressed]),
  });
  await expectReject(buf, "ZIP_STRUCTURE_INVALID");
});

test("reject: overlapping entries", async () => {
  const buf = buildZip(
    docxEntries({
      transform: (es) => es.map((e, i) => (i === 2 ? { ...e, central: { compressedSize: 4000 } } : e)),
    }),
  );
  await expectReject(buf, "ZIP_STRUCTURE_INVALID");
});

test("reject: ZIP64 sentinels", async () => {
  const buf = buildZip(docxEntries(), { eocd: { cdOffset: 0xffffffff } });
  await expectReject(buf, "ZIP_UNSUPPORTED_FEATURE");
});

test("reject: encrypted entry flag", async () => {
  const buf = buildZip(
    docxEntries({
      transform: (es) => es.map((e, i) => (i === 0 ? { ...e, central: { flags: 0x1 } } : e)),
    }),
  );
  await expectReject(buf, "ZIP_UNSUPPORTED_FEATURE");
});

test("reject: unsupported compression method", async () => {
  const buf = buildZip(
    docxEntries({
      transform: (es) => es.map((e, i) => (i === 0 ? { ...e, central: { method: 12 } } : e)),
    }),
  );
  await expectReject(buf, "ZIP_UNSUPPORTED_FEATURE");
});

test("reject: multi-disk EOCD", async () => {
  const buf = buildZip(docxEntries(), { eocd: { diskNumber: 1 } });
  await expectReject(buf, "ZIP_UNSUPPORTED_FEATURE");
});

test("reject: not a zip file", async () => {
  await expectReject(Buffer.from("this is plainly not a zip archive at all........"), "NOT_ZIP");
});

test("reject: empty file", async () => {
  await expectReject(Buffer.alloc(0), "NOT_ZIP");
});

// ---------- entry path rules ----------

test("reject: absolute entry path", async () => {
  const entries: EntrySpec[] = [...docxEntries(), { name: "/abs.txt", data: "x" }];
  await expectReject(buildZip(entries), "ZIP_PATH_INVALID");
});

test("reject: backslash in entry path", async () => {
  const entries: EntrySpec[] = [...docxEntries(), { name: "word\\evil.xml", data: "x" }];
  await expectReject(buildZip(entries), "ZIP_PATH_INVALID");
});

test("reject: empty path segment", async () => {
  const entries: EntrySpec[] = [...docxEntries(), { name: "word//x.xml", data: "x" }];
  await expectReject(buildZip(entries), "ZIP_PATH_INVALID");
});

test("reject: dot and dot-dot segments", async () => {
  await expectReject(buildZip([...docxEntries(), { name: "word/./x.xml", data: "x" }]), "ZIP_PATH_INVALID");
  await expectReject(buildZip([...docxEntries(), { name: "word/../x.xml", data: "x" }]), "ZIP_PATH_INVALID");
});

test("reject: file/directory name collision", async () => {
  const entries: EntrySpec[] = [
    ...docxEntries(),
    { name: "word/theme/", method: 0 },
    { name: "word/theme", data: "x" },
  ];
  await expectReject(buildZip(entries), "ZIP_PATH_INVALID");
});

test("reject: duplicate entry names", async () => {
  const entries: EntrySpec[] = [...docxEntries(), { name: "dup.xml", data: "a" }, { name: "dup.xml", data: "b" }];
  await expectReject(buildZip(entries), "ZIP_STRUCTURE_INVALID");
});

test("reject: non-ASCII name without UTF-8 flag", async () => {
  const entries: EntrySpec[] = [...docxEntries(), { name: "word/注释.txt", data: "x", utf8Flag: false }];
  await expectReject(buildZip(entries), "ZIP_PATH_INVALID");
});
