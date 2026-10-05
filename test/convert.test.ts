import test from "node:test";
import assert from "node:assert/strict";
import { convertRecords } from "../src/convert.js";
import type { JsonObject, MappingDefinition } from "../src/types.js";

const HR_DEFINITION: MappingDefinition = {
  rules: [
    { source: "id", target: "employeeId" },
    { source: "profile.name", target: "person.fullName" },
    { source: "profile.hiredAt", target: "person.hiredAt", transform: { kind: "date" } },
    {
      source: "profile.status",
      target: "person.status",
      transform: { kind: "enum", values: ["ACTIVE", "LEFT"] },
    },
    {
      source: "payroll.*.gross",
      target: "entries.*.amount",
      transform: { kind: "unit", numerator: "1", denominator: "100", scale: 2 },
    },
    {
      source: "payroll.*.paidAt",
      target: "entries.*.paidAt",
      transform: { kind: "date" },
    },
    { source: "payroll.*.currency", target: "entries.*.currency" },
  ],
};

test("嵌套数组混合缺失、空值与失败字段时，元素位置与可用字段保持不变", () => {
  const records: JsonObject[] = [
    {
      id: "E1",
      profile: { name: "Ann", hiredAt: "2024-03-01T10:00:00+08:00", status: "ACTIVE" },
      payroll: [
        { gross: "100005", paidAt: "2024-01-01T00:30:00+08:00", currency: "CNY" },
        { gross: "bad", paidAt: null, currency: "CNY" }, // 换算失败 + null 日期
        { paidAt: "2024-13-01T00:00:00Z" }, // gross 缺失 + 非法日期
        {}, // 全部缺失 -> 保留空对象
      ],
    },
    {
      id: "E2",
      profile: { name: null, hiredAt: "2024-02-30T00:00:00Z", status: "active" }, // 非法日期 + 未声明枚举
      payroll: null, // 数组为 null -> 目标为 null
    },
    {
      id: "E3",
      profile: { hiredAt: "2024-01-01T00:00:00Z", status: "LEFT" }, // name 缺失
      payroll: [], // 空数组 -> 目标空数组
    },
    {
      id: "E4",
      profile: { name: "Dee", hiredAt: "2024-01-01T00:00:00Z", status: "ACTIVE" },
      // payroll 缺失 -> 目标缺失
    },
  ];

  const result = convertRecords(HR_DEFINITION, records);

  assert.deepEqual(result.records, [
    {
      employeeId: "E1",
      person: {
        fullName: "Ann",
        hiredAt: "2024-03-01T02:00:00.000Z",
        status: "ACTIVE",
      },
      entries: [
        { amount: "1000.05", paidAt: "2023-12-31T16:30:00.000Z", currency: "CNY" },
        { paidAt: null, currency: "CNY" }, // amount 失败被省略，其余保留
        {}, // 两个字段都失败/缺失，仍保留空对象
        {},
      ],
    },
    {
      employeeId: "E2",
      person: { fullName: null }, // null 原样保留；日期与枚举失败被省略
      entries: null,
    },
    {
      employeeId: "E3",
      person: { hiredAt: "2024-01-01T00:00:00.000Z", status: "LEFT" },
      entries: [],
    },
    {
      employeeId: "E4",
      person: { fullName: "Dee", hiredAt: "2024-01-01T00:00:00.000Z", status: "ACTIVE" },
    },
  ]);

  // 错误可定位到源记录、数组下标与目标字段。
  assert.deepEqual(result.errors, [
    {
      recordIndex: 0,
      arrayIndex: 1,
      sourcePath: "payroll.*.gross",
      targetPath: "entries.*.amount",
      reason: "非法十进制字符串: bad",
    },
    {
      recordIndex: 0,
      arrayIndex: 2,
      sourcePath: "payroll.*.paidAt",
      targetPath: "entries.*.paidAt",
      reason: "非法 RFC3339 时间戳: 2024-13-01T00:00:00Z",
    },
    {
      recordIndex: 1,
      arrayIndex: null,
      sourcePath: "profile.hiredAt",
      targetPath: "person.hiredAt",
      reason: "非法 RFC3339 时间戳: 2024-02-30T00:00:00Z",
    },
    {
      recordIndex: 1,
      arrayIndex: null,
      sourcePath: "profile.status",
      targetPath: "person.status",
      reason: "未声明的枚举值: active",
    },
  ]);
});

test("每条源记录恰好一条输出，顺序不变；未声明字段不进入输出", () => {
  const records: JsonObject[] = [
    { id: "A", extra: "ignored", profile: { name: "n1", hiredAt: "2024-01-01T00:00:00Z", status: "ACTIVE", secret: 1 } },
    { id: "B", profile: { name: "n2", hiredAt: "2024-01-02T00:00:00Z", status: "LEFT" } },
    { id: "C", profile: { name: "n3", hiredAt: "2024-01-03T00:00:00Z", status: "ACTIVE" } },
  ];
  const result = convertRecords(HR_DEFINITION, records);
  assert.equal(result.records.length, 3);
  assert.deepEqual(
    result.records.map((r) => r["employeeId"]),
    ["A", "B", "C"],
  );
  assert.equal(JSON.stringify(result.records[0]).includes("secret"), false);
  assert.equal(JSON.stringify(result.records[0]).includes("extra"), false);
});

test("定义与源记录在转换后均不被修改", () => {
  const definition: MappingDefinition = JSON.parse(JSON.stringify(HR_DEFINITION));
  const defSnapshot = JSON.stringify(definition);
  const records: JsonObject[] = JSON.parse(
    JSON.stringify([
      { id: "E1", profile: { name: "Ann", hiredAt: "bad", status: "ACTIVE" }, payroll: [{ gross: "x" }] },
    ]),
  );
  const recSnapshot = JSON.stringify(records);
  convertRecords(definition, records);
  assert.equal(JSON.stringify(definition), defSnapshot);
  assert.equal(JSON.stringify(records), recSnapshot);
});

test("错误批次之后再次转换正常批次，结果与首次一致", () => {
  const good: JsonObject[] = [
    { id: "G1", profile: { name: "Good", hiredAt: "2024-05-01T08:00:00+08:00", status: "ACTIVE" }, payroll: [{ gross: "500", paidAt: "2024-05-02T00:00:00Z", currency: "CNY" }] },
  ];
  const bad: JsonObject[] = [
    { id: "B1", profile: { name: "Bad", hiredAt: "not-a-date", status: "UNKNOWN" }, payroll: [{ gross: "oops" }] },
  ];
  const first = convertRecords(HR_DEFINITION, good);
  const errorBatch = convertRecords(HR_DEFINITION, bad);
  assert.equal(errorBatch.errors.length > 0, true);
  const second = convertRecords(HR_DEFINITION, good);
  assert.deepEqual(second, first);
});

test("目标路径冲突的定义被整体拒绝（转换抛错）", () => {
  const conflicted: MappingDefinition = {
    rules: [
      { source: "a", target: "x" },
      { source: "b", target: "x" },
    ],
  };
  assert.throws(() => convertRecords(conflicted, [{ a: "1", b: "2" }]));
});

test("大数、中点舍入与跨日时区偏移的端到端结果与手算一致", () => {
  const definition: MappingDefinition = {
    rules: [
      {
        source: "big",
        target: "big",
        transform: { kind: "unit", numerator: "3", denominator: "7", scale: 6 },
      },
      {
        source: "mid",
        target: "mid",
        transform: { kind: "unit", numerator: "1", denominator: "1", scale: 2 },
      },
      {
        source: "negMid",
        target: "negMid",
        transform: { kind: "unit", numerator: "1", denominator: "1", scale: 2 },
      },
      { source: "ts", target: "ts", transform: { kind: "date" } },
    ],
  };
  const result = convertRecords(definition, [
    {
      big: "999999999999999999999999999999",
      mid: "0.025",
      negMid: "-0.015",
      ts: "2024-01-01T00:30:00+08:00",
    },
  ]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.records, [
    {
      big: "428571428571428571428571428571.000000",
      mid: "0.02",
      negMid: "-0.02",
      ts: "2023-12-31T16:30:00.000Z",
    },
  ]);
});

test("性能：1000 条记录 x 20 个数组元素 x 30 条映射在 2 秒内完成", () => {
  const rules = [];
  for (let i = 0; i < 10; i += 1) {
    rules.push({ source: `f${i}`, target: `out.p${i}` });
    rules.push({
      source: `items.*.a${i}`,
      target: `rows.*.x${i}`,
      transform: { kind: "unit", numerator: "7", denominator: "3", scale: 4 },
    });
    rules.push({
      source: `items.*.d${i}`,
      target: `rows.*.y${i}`,
      transform: { kind: "date" },
    });
  }
  const definition: MappingDefinition = { rules: rules as MappingDefinition["rules"] };
  const records: JsonObject[] = [];
  for (let r = 0; r < 1000; r += 1) {
    const record: JsonObject = {};
    const items = [];
    for (let e = 0; e < 20; e += 1) {
      const element: JsonObject = {};
      for (let i = 0; i < 10; i += 1) {
        element[`a${i}`] = "12345.6789";
        element[`d${i}`] = "2024-06-01T12:00:00+08:00";
      }
      items.push(element);
    }
    for (let i = 0; i < 10; i += 1) record[`f${i}`] = `v${i}`;
    record["items"] = items;
    records.push(record);
  }
  const start = Date.now();
  const result = convertRecords(definition, records);
  const elapsed = Date.now() - start;
  assert.equal(result.records.length, 1000);
  assert.equal(result.errors.length, 0);
  assert.equal(elapsed < 2000, true, `耗时 ${elapsed}ms`);
});
