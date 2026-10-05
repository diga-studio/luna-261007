import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runImport, metaOf, recordsOf, makeCsv } from './helpers.js';
/** 用每列的样本值构造 100 行 CSV 并返回判定类型与事件。 */
async function detect(columns, extraRows = []) {
    const header = columns.map((_, i) => `c${i + 1}`);
    const rows = [];
    const n = Math.max(...columns.map((c) => c.length));
    for (let r = 0; r < n; r++) {
        rows.push(columns.map((c) => c[r] ?? ''));
    }
    const csv = makeCsv(header, [...rows, ...extraRows]);
    const events = await runImport(csv, 65536);
    return { types: metaOf(events).types, events };
}
const fill = (v, n) => new Array(n).fill(v);
test('恰好 80% 命中即有资格，79% 不够', async () => {
    const t80 = await detect([[...fill('true', 80), ...fill('xyz', 20)]]);
    assert.equal(t80.types[0], 'boolean');
    const t79 = await detect([[...fill('true', 79), ...fill('xyz', 21)]]);
    assert.equal(t79.types[0], 'text');
});
test('空值不计入分母：80 非空中 64 命中即 80%', async () => {
    const { types } = await detect([
        [...fill('true', 64), ...fill('no', 16), ...fill('', 20)],
    ]);
    assert.equal(types[0], 'boolean');
});
test('全空列为 text', async () => {
    const { types } = await detect([[...fill('', 100)], [...fill('1', 100)]]);
    assert.deepEqual(types, ['text', 'integer']);
});
test('全空记录仍占采样名额', async () => {
    // 前 100 条全空，之后 50 条都是 true：采样全空 -> text，后续不调整。
    const rows = [...fill('', 100), ...fill('true', 50)].map((v) => [v]);
    const csv = makeCsv(['a'], rows);
    const events = await runImport(csv, 65536);
    assert.equal(metaOf(events).types[0], 'text');
    const records = recordsOf(events);
    assert.equal(records.length, 150);
    assert.equal(records[149].cells[0], 'true'); // text 保持原文
    assert.equal(records[0].cells[0], null); // 空值输出 null
});
test('integer 与 float 同时达标时取 integer', async () => {
    const { types } = await detect([[...fill('42', 90), ...fill('x', 10)]]);
    assert.equal(types[0], 'integer');
});
test('小数达标判为 float', async () => {
    const { types } = await detect([[...fill('1.5', 80), ...fill('x', 20)]]);
    assert.equal(types[0], 'float');
});
test('优先级顺序 boolean > integer > float > date > url > email', async () => {
    // "true" 只命中 boolean；构造同时命中 date 与 url 不可能，分别验证。
    const cases = [
        ['TRUE', 'boolean'],
        ['-17', 'integer'],
        ['+3.25e-4', 'float'],
        ['02/29/2000', 'date'],
        ['https://a.b/c', 'url'],
        ['a-b@cd.ef', 'email'],
    ];
    for (const [value, expected] of cases) {
        const { types } = await detect([[...fill(value, 85), ...fill('zz', 15)]]);
        assert.equal(types[0], expected, value);
    }
});
test('采样后出现不兼容值：保留原文、产生警告、不丢行', async () => {
    const { types, events } = await detect([[...fill('true', 100)]], [['notabool'], ['false'], ['']]);
    assert.equal(types[0], 'boolean');
    const records = recordsOf(events);
    assert.equal(records.length, 103);
    const bad = records[100];
    assert.equal(bad.index, 101);
    assert.equal(bad.cells[0], 'notabool');
    assert.deepEqual(bad.warnings, [
        { record: 101, column: 1, expectedType: 'boolean', value: 'notabool' },
    ]);
    assert.equal(records[101].cells[0], false);
    assert.equal(records[102].cells[0], null);
    assert.equal(records[101].warnings.length, 0);
});
test('integer 转换失败也产生警告', async () => {
    const { events } = await detect([[...fill('7', 100)]], [['7.5']]);
    const bad = recordsOf(events)[100];
    assert.equal(bad.cells[0], '7.5');
    assert.equal(bad.warnings.length, 1);
    assert.equal(bad.warnings[0].expectedType, 'integer');
});
test('首尾含 White_Space 的非空值只能匹配 text', async () => {
    const { types } = await detect([
        [...fill(' true', 50), ...fill('true　', 50)], // 含半角空格与全角空格
    ]);
    assert.equal(types[0], 'text');
});
test('全空记录仍占采样名额', async () => {
    // 前 50 条全空，51-100 为 TRUE；若全空记录不占名额，
    // 采样会纳入 101 条之后的 xyz，导致 boolean 命中率降至 50%。
    const rows = [
        ...Array.from({ length: 50 }, () => ['', '']),
        ...Array.from({ length: 50 }, () => ['TRUE', '']),
        ...Array.from({ length: 50 }, () => ['xyz', '']),
    ];
    const csv = makeCsv(['a', 'b'], rows);
    const events = await runImport(csv, 4096);
    assert.deepEqual(metaOf(events).types, ['boolean', 'text']);
    const records = recordsOf(events);
    assert.equal(records.length, 150);
    // 采样后出现的 xyz 不兼容：保留原文并告警。
    assert.equal(records[100].cells[0], 'xyz');
    assert.equal(records[100].warnings.length, 1);
    // 全空记录的单元格输出 null。
    assert.deepEqual(records[0].cells, [null, null]);
});
