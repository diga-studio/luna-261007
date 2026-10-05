import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runImport, metaOf, recordsOf } from './helpers.js';

// 含多字节字符、引号内换行与逗号、双引号转义、CRLF/LF 混合、BOM、末尾无换行。
const CSV =
  '﻿id,名字,备注,主页\n' +
  '1,"张三","他说""你好""，然后\n换行了",http://example.com\n' +
  '2,"李�四","含,逗号","https://例え.jp/パス?a=1"\r\n' +
  '3,"emoji 🎉✨","行1\n行2\r\n行3",HTTP://UPPER.EXAMPLE/path\n' +
  '4,"","",""';

test('相同 CSV 按不同字节边界分块，结果完全一致', async () => {
  const reference = await runImport(CSV, Number.MAX_SAFE_INTEGER);
  for (const size of [1, 2, 3, 4, 5, 7, 11, 13, 64, 1024, 65536]) {
    const events = await runImport(CSV, size);
    assert.deepEqual(events, reference, `chunk size ${size}`);
  }
});

test('解析内容正确：引号、换行、转义、多字节原样保留', async () => {
  const events = await runImport(CSV, 3);
  const meta = metaOf(events);
  assert.deepEqual(meta.header, ['id', '名字', '备注', '主页']);
  assert.deepEqual(meta.types, ['integer', 'text', 'text', 'url']);

  const records = recordsOf(events);
  assert.equal(records.length, 4);
  assert.deepEqual(records[0]!.cells, [
    1,
    '张三',
    '他说"你好"，然后\n换行了',
    'http://example.com',
  ]);
  assert.deepEqual(records[1]!.cells, [
    2,
    '李�四',
    '含,逗号',
    'https://例え.jp/パス?a=1',
  ]);
  assert.deepEqual(records[2]!.cells, [
    3,
    'emoji 🎉✨',
    '行1\n行2\r\n行3',
    'HTTP://UPPER.EXAMPLE/path',
  ]);
  assert.deepEqual(records[3]!.cells, [4, null, null, null]);
  for (const r of records) assert.deepEqual(r.warnings, []);
});

test('CRLF 与 LF 混合、末尾无换行时记录边界一致', async () => {
  const csv = 'a,b\r\n1,2\n3,4\r\n5,6';
  const events = await runImport(csv, 1);
  const records = recordsOf(events);
  assert.equal(records.length, 3);
  assert.deepEqual(records.map((r) => r.cells), [
    [1, 2],
    [3, 4],
    [5, 6],
  ]);
});

test('空输入不产生任何事件', async () => {
  assert.deepEqual(await runImport('', 1), []);
});

test('仅表头时交付 meta 且无记录', async () => {
  const events = await runImport('a,b,c\n', 2);
  const meta = metaOf(events);
  assert.deepEqual(meta.header, ['a', 'b', 'c']);
  assert.deepEqual(meta.types, ['text', 'text', 'text']);
  assert.equal(recordsOf(events).length, 0);
});
