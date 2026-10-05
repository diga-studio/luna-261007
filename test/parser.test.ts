import test from "node:test";
import assert from "node:assert/strict";
import { CsvRecordParser } from "../src/parser.js";

function parseAll(chunks: string[]): string[][] {
  const p = new CsvRecordParser();
  const out: string[][] = [];
  for (const c of chunks) out.push(...p.push(c));
  out.push(...p.end());
  return out;
}

/** 按每种切分方式解析，结果都必须一致。 */
function assertChunkInvariant(text: string, expected: string[][]): void {
  assert.deepEqual(parseAll([text]), expected, "single chunk");
  for (let size = 1; size <= 7; size++) {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
    assert.deepEqual(parseAll(chunks), expected, `char chunk size ${size}`);
  }
}

test("基本逗号分隔与 LF / CRLF 混合", () => {
  assertChunkInvariant("a,b\nc,d\r\ne,f\n", [
    ["a", "b"],
    ["c", "d"],
    ["e", "f"],
  ]);
});

test("末条记录可无换行", () => {
  assertChunkInvariant("a,b\n1,2", [
    ["a", "b"],
    ["1", "2"],
  ]);
});

test("双引号字段：逗号与换行属于内容并原样保留", () => {
  assertChunkInvariant('"x,y","line1\nline2","crlf\r\ninside"\n1,2,3', [
    ["x,y", "line1\nline2", "crlf\r\ninside"],
    ["1", "2", "3"],
  ]);
});

test("连续两个双引号表示一个双引号", () => {
  assertChunkInvariant('"a""b","""",x"y\n', [["a\"b", '"', 'x"y']]);
});

test("引号内容跨任意块边界", () => {
  assertChunkInvariant('"ab\ncd""e",f\n"g",h', [
    ["ab\ncd\"e", "f"],
    ["g", "h"],
  ]);
});

test("CR 与 LF 分属不同块", () => {
  assert.deepEqual(parseAll(["a,b\r", "\nc,d"]), [
    ["a", "b"],
    ["c", "d"],
  ]);
  assert.deepEqual(parseAll(["a,b\r"]), [["a", "b"]]);
});

test("空字段与全空记录", () => {
  assertChunkInvariant("a,b\n,\n,,", [
    ["a", "b"],
    ["", ""],
    ["", "", ""],
  ]);
});

test("多字节字符内容原样保留", () => {
  assertChunkInvariant("名字,备注\n汉字,👍好\n", [
    ["名字", "备注"],
    ["汉字", "👍好"],
  ]);
});
