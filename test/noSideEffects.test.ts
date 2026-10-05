import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateDocxFile } from "../src/index.ts";
import { buildZip, docxEntries } from "./helpers/zipBuilder.ts";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "docx-side-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function hash(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

describe("无副作用", () => {
  it("合法输入：不改写文件，不留下解压残留", async () => {
    const { buf } = buildZip(docxEntries());
    const p = join(dir, "ok.bin");
    await writeFile(p, buf);
    const before = await readdir(dir);
    const r = await validateDocxFile(p);
    expect(r.ok).toBe(true);
    expect(await readdir(dir)).toEqual(before);
    expect(hash(await readFile(p))).toBe(hash(buf));
  });

  it("拒收输入：不改写文件，不留下解压残留", async () => {
    const { buf } = buildZip(
      docxEntries({ extra: [{ name: "word/../evil.xml", data: "<x/>" }] }),
    );
    const p = join(dir, "bad.bin");
    await writeFile(p, buf);
    const before = await readdir(dir);
    const r = await validateDocxFile(p);
    expect(r.ok).toBe(false);
    expect(await readdir(dir)).toEqual(before);
    expect(hash(await readFile(p))).toBe(hash(buf));
  });

  it("不存在的文件：返回 IO_ERROR 而非抛出", async () => {
    const r = await validateDocxFile(join(dir, "does-not-exist.bin"));
    expect(r).toMatchObject({ ok: false, code: "IO_ERROR" });
  });
});
