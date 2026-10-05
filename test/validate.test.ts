import test from "node:test";
import assert from "node:assert/strict";
import { validateDefinition } from "../src/validate.js";
import type { MappingDefinition } from "../src/types.js";

test("合法定义通过", () => {
  const def: MappingDefinition = {
    rules: [
      { source: "a", target: "x.y" },
      { source: "b.c", target: "x.z", transform: { kind: "date" } },
      { source: "list.*.v", target: "out.*.value", transform: { kind: "enum", values: ["A"] } },
      { source: "list.*.w", target: "out.*.weight", transform: { kind: "unit", numerator: "1", denominator: "1000", scale: 3 } },
    ],
  };
  assert.deepEqual(validateDefinition(def), { ok: true });
});

test("目标叶子被多条规则占用 -> 整体拒绝", () => {
  const def: MappingDefinition = {
    rules: [
      { source: "a", target: "x" },
      { source: "b", target: "x" },
    ],
  };
  const result = validateDefinition(def);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.errors.some((e) => e.code === "target_conflict"), true);
  }
});

test("目标位置作叶子又作容器 -> 整体拒绝", () => {
  const cases: MappingDefinition[] = [
    { rules: [{ source: "a", target: "x" }, { source: "b", target: "x.y" }] },
    { rules: [{ source: "a", target: "x.y" }, { source: "b", target: "x" }] },
    { rules: [{ source: "a", target: "x" }, { source: "b.*.y", target: "x.*.y" }] },
  ];
  for (const def of cases) {
    const result = validateDefinition(def);
    assert.equal(result.ok, false, JSON.stringify(def));
    if (!result.ok) {
      assert.equal(result.errors.some((e) => e.code === "target_conflict"), true);
    }
  }
});

test("目标位置兼作对象与数组容器 -> 整体拒绝", () => {
  const def: MappingDefinition = {
    rules: [
      { source: "a.*.v", target: "x.*.v" },
      { source: "b", target: "x.y" },
    ],
  };
  const result = validateDefinition(def);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.errors.some((e) => e.code === "target_conflict"), true);
  }
});

test("同一目标数组来自不同源数组 -> 整体拒绝", () => {
  const def: MappingDefinition = {
    rules: [
      { source: "a.*.v", target: "x.*.v" },
      { source: "b.*.w", target: "x.*.w" },
    ],
  };
  const result = validateDefinition(def);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.errors.some((e) => e.code === "array_source_conflict"), true);
  }
  // 同一源数组则可以
  const okDef: MappingDefinition = {
    rules: [
      { source: "a.*.v", target: "x.*.v" },
      { source: "a.*.w", target: "x.*.w" },
    ],
  };
  assert.deepEqual(validateDefinition(okDef), { ok: true });
});

test("数组层级不一致 -> 整体拒绝", () => {
  const cases: MappingDefinition[] = [
    { rules: [{ source: "a.*.v", target: "x.v" }] },
    { rules: [{ source: "a.v", target: "x.*.v" }] },
  ];
  for (const def of cases) {
    const result = validateDefinition(def);
    assert.equal(result.ok, false, JSON.stringify(def));
    if (!result.ok) {
      assert.equal(result.errors.some((e) => e.code === "array_mismatch"), true);
    }
  }
});

test("非法路径与非法转换参数 -> 整体拒绝", () => {
  const cases: MappingDefinition[] = [
    { rules: [{ source: "", target: "x" }] },
    { rules: [{ source: "a..b", target: "x" }] },
    { rules: [{ source: "*.a", target: "x" }] },
    { rules: [{ source: "a.*.*.b", target: "x.*.*.b" }] },
    { rules: [{ source: "a", target: "x", transform: { kind: "enum", values: [] } }] },
    { rules: [{ source: "a", target: "x", transform: { kind: "enum", values: [1] as unknown as string[] } }] },
    { rules: [{ source: "a", target: "x", transform: { kind: "unit", numerator: "1.5", denominator: "1", scale: 2 } }] },
    { rules: [{ source: "a", target: "x", transform: { kind: "unit", numerator: "1", denominator: "0", scale: 2 } }] },
    { rules: [{ source: "a", target: "x", transform: { kind: "unit", numerator: "1", denominator: "1", scale: 7 } }] },
    { rules: [{ source: "a", target: "x", transform: { kind: "nope" } as never }] },
  ];
  for (const def of cases) {
    assert.equal(validateDefinition(def).ok, false, JSON.stringify(def));
  }
});

test("定义检查不修改传入定义", () => {
  const def: MappingDefinition = {
    rules: [{ source: "a", target: "x", transform: { kind: "enum", values: ["A", "B"] } }],
  };
  const snapshot = JSON.stringify(def);
  validateDefinition(def);
  assert.equal(JSON.stringify(def), snapshot);
});
