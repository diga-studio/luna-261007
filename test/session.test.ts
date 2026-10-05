import test from "node:test";
import assert from "node:assert/strict";
import { createImportSession } from "../src/index.js";
import type { CsvByteSource } from "../src/index.js";
import {
  chunkBytes,
  chunkRandom,
  collect,
  collectSession,
  encode,
  sourceOf,
} from "./helpers.js";

/** 构造含多字节字符、引号内换行、双引号转义的 CSV。 */
function buildTrickyCsv(recordCount: number): string {
  const lines = ["name,flag,age,score,day,site,mail,note"];
  for (let i = 0; i < recordCount; i++) {
    lines.push(
      [
        `"用户${i}，含,逗号"`,
        i % 2 === 0 ? "TRUE" : "false",
        String(20 + (i % 50)),
        (i % 3) + 0.5 === 0.5 ? "0.5" : `${(i % 7) + 1}.25`,
        `0${(i % 9) + 1}/15/2024`,
        `https://example.com/${i}?x=汉字`,
        `user${i}@example.com`,
        `"第${i}行\n第二行 ""引号"" 👍"`,
      ].join(","),
    );
  }
  return lines.join("\r\n");
}

test("相同 CSV 按不同字节边界分块，类型、记录、警告完全一致", async () => {
  const csv = buildTrickyCsv(150);
  const data = encode(csv);
  const baseline = await collect(csv, data.length); // 单块
  assert.equal(baseline.rows.length, 150);
  const chunkings = [1, 2, 3, 5, 7, 13, 64, 1024, 65536];
  for (const size of chunkings) {
    const got = await collect(csv, size);
    assert.deepEqual(got, baseline, `chunk size ${size}`);
  }
  for (const seed of [1, 42, 2024]) {
    const session = await createImportSession(sourceOf(chunkRandom(data, seed)));
    const got = await collectSession(session);
    assert.deepEqual(got, baseline, `random chunking seed ${seed}`);
  }
});

test("BOM、CRLF、引号内换行、无末尾换行", async () => {
  const csv = "﻿name,memo\r\n\"a\nb\",\"x\"\"y\"\r\n末行,无换行";
  const got = await collect(csv, 3);
  assert.deepEqual(got.header, ["name", "memo"]);
  assert.deepEqual(got.rows[0]!.cells, ["a\nb", 'x"y']);
  assert.deepEqual(got.rows[1]!.cells, ["末行", "无换行"]);
});

test("空值输出 null，全空记录仍占采样名额", async () => {
  // 100 条采样中夹 20 条全空记录；非空值 80% 为 integer。
  const lines = ["a,b"];
  for (let i = 0; i < 100; i++) {
    if (i % 5 === 0) lines.push(",");
    else lines.push(`${i},x${i}`);
  }
  lines.push("101,x101");
  const got = await collect(lines.join("\n"), 4096);
  assert.deepEqual(got.types, ["integer", "text"]);
  assert.equal(got.rows.length, 101);
  assert.deepEqual(got.rows[0]!.cells, [null, null]); // 全空记录
  assert.deepEqual(got.rows[1]!.cells, [1, "x1"]);
});

test("采样后出现不兼容值：保留原文并产生可定位警告，不丢行", async () => {
  const lines = ["n,s"];
  for (let i = 0; i < 100; i++) lines.push(`${i},t${i}`);
  lines.push("not-a-number,t100");
  lines.push("102,t101");
  const got = await collect(lines.join("\n"), 1000);
  assert.deepEqual(got.types, ["integer", "text"]);
  assert.equal(got.rows.length, 102);
  const bad = got.rows[100]!;
  assert.equal(bad.recordIndex, 100);
  assert.deepEqual(bad.cells, ["not-a-number", "t100"]);
  assert.deepEqual(bad.warnings, [
    { recordIndex: 100, columnIndex: 0, raw: "not-a-number", columnType: "integer" },
  ]);
  assert.deepEqual(got.rows[101]!.cells, [102, "t101"]);
  assert.equal(got.rows[101]!.warnings.length, 0);
});

test("恰好 80% 命中决定类型（端到端）", async () => {
  const lines = ["v"];
  for (let i = 0; i < 80; i++) lines.push("12/25/2024");
  for (let i = 0; i < 20; i++) lines.push(`文本${i}`);
  const got = await collect(lines.join("\n"), 4096);
  assert.deepEqual(got.types, ["date"]);
  // 79 条则为 text。
  const lines2 = ["v"];
  for (let i = 0; i < 79; i++) lines2.push("12/25/2024");
  for (let i = 0; i < 21; i++) lines2.push(`文本${i}`);
  const got2 = await collect(lines2.join("\n"), 4096);
  assert.deepEqual(got2.types, ["text"]);
});

test("获得第 100 条完整数据记录后即交付列类型，无需更多输入", async () => {
  const lines = ["a,b"];
  for (let i = 0; i < 100; i++) lines.push(`${i},true`);
  const data = encode(lines.join("\n") + "\n");
  // 可控源：发出全部字节后挂起，永不结束。
  let resumed = false;
  async function* source(): CsvByteSource {
    yield data;
    await new Promise<void>(() => {
      resumed = true;
    });
  }
  const session = await createImportSession(source());
  assert.equal(resumed, false);
  assert.deepEqual(session.header, ["a", "b"]);
  assert.deepEqual(await session.types, ["integer", "boolean"]);
  // 采样记录也能交付。
  const iter = session.rows[Symbol.asyncIterator]();
  const first = await iter.next();
  assert.equal(first.done, false);
  assert.deepEqual(first.value.cells, [0, true]);
});

test("不足 100 条时在流结束后交付", async () => {
  const lines = ["a"];
  for (let i = 0; i < 40; i++) lines.push(`${i}`);
  let sourceDone = false;
  async function* source(): CsvByteSource {
    yield encode(lines.join("\n"));
    sourceDone = true;
  }
  const session = await createImportSession(source());
  assert.equal(sourceDone, true);
  assert.deepEqual(await session.types, ["integer"]);
  const got = await collectSession(session);
  assert.equal(got.rows.length, 40);
});

test("类型确定后调用方暂停消费，累计额外读取不超过 64 KiB", async () => {
  // 200 条记录，每条约 1 KiB，输入块 64 KiB。
  const cell = "汉".repeat(300); // 约 900 字节
  const lines = ["v"];
  for (let i = 0; i < 200; i++) lines.push(`${i % 10},${cell}`);
  const data = encode(lines.join("\n") + "\n");
  const chunkSize = 64 * 1024;
  let pulled = 0;
  async function* source(): CsvByteSource {
    for (let i = 0; i < data.length; i += chunkSize) {
      const c = data.subarray(i, Math.min(i + chunkSize, data.length));
      pulled += c.length;
      yield c;
    }
  }
  const session = await createImportSession(source());
  const pulledAfterSampling = pulled;
  const iter = session.rows[Symbol.asyncIterator]();
  // 暂停消费时不应再读取。
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(pulled, pulledAfterSampling);
  // 逐条消费：类型确定后的累计额外读取始终不超过一个输入块（64 KiB）。
  for (let k = 0; k < 200; k++) {
    const next = await iter.next();
    assert.equal(next.done, false);
    const extra = pulled - pulledAfterSampling;
    assert.ok(
      extra <= chunkSize,
      `row ${k}: extra read ${extra} > 64 KiB`,
    );
  }
});

test("表头即首条逻辑记录，不参与判型", async () => {
  const got = await collect("1,2,3\n4,5,6", 100);
  assert.deepEqual(got.header, ["1", "2", "3"]);
  assert.equal(got.rows.length, 1);
  assert.deepEqual(got.rows[0]!.cells, [4, 5, 6]);
});

test("空输入与仅表头输入", async () => {
  const empty = await collect("", 100);
  assert.deepEqual(empty.header, []);
  assert.deepEqual(empty.types, []);
  assert.equal(empty.rows.length, 0);
  const headerOnly = await collect("a,b,c\n", 100);
  assert.deepEqual(headerOnly.header, ["a", "b", "c"]);
  assert.deepEqual(headerOnly.types, ["text", "text", "text"]);
  assert.equal(headerOnly.rows.length, 0);
});
