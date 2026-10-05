import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateStore } from "../src/index.js";
import type { AddressRule, NapProfile } from "../src/index.js";

function profile(overrides: Partial<NapProfile> = {}): NapProfile {
  return {
    name: "Acme Store",
    phone: "555-0100",
    street: "12 Main St",
    city: "Springfield",
    state: "CA",
    postalCode: "90001",
    unit: null,
    ...overrides,
  };
}

test("目录资料为空时判定为缺失", () => {
  const result = evaluateStore(profile(), null, []);
  assert.equal(result.verdict, "missing");
  assert.equal(result.evidence, undefined);
});

test("非街道字段任一不同即为冲突", () => {
  const cases: Partial<NapProfile>[] = [
    { name: "Other" },
    { phone: "555-9999" },
    { city: "Other City" },
    { state: "NY" },
    { postalCode: "10001" },
    { unit: "Apt 2" },
  ];
  for (const overrides of cases) {
    const result = evaluateStore(profile(), profile(overrides), []);
    assert.equal(result.verdict, "conflict", JSON.stringify(overrides));
  }
});

test("一侧有单元号而另一侧没有即为冲突", () => {
  const result = evaluateStore(
    profile({ unit: null }),
    profile({ unit: "Suite 3" }),
    [],
  );
  assert.equal(result.verdict, "conflict");
});

test("St 同时可解释为 Street 与 Saint 时必须待核验", () => {
  const rules: AddressRule[] = [
    { from: ["St"], to: ["Street"] },
    { from: ["St"], to: ["Saint"] },
  ];
  const result = evaluateStore(
    profile({ street: "12 St" }),
    profile({ street: "12 Street" }),
    rules,
  );
  assert.equal(result.verdict, "needs_review");
  assert.deepEqual(result.evidence?.commonSequence, ["12", "street"]);
  assert.deepEqual(result.evidence?.canonicalOnlySequence, ["12", "saint"]);
  assert.deepEqual(result.evidence?.directoryOnlySequence, ["12", "street"]);
});

test("重叠规则下选择覆盖最多的解释后一致", () => {
  const rules: AddressRule[] = [
    { from: ["N", "Main"], to: ["North", "Main"] },
    { from: ["N"], to: ["North"] },
    { from: ["Main", "St"], to: ["Main", "Street"] },
  ];
  const result = evaluateStore(
    profile({ street: "12 N Main St" }),
    profile({ street: "12 North Main Street" }),
    rules,
  );
  assert.equal(result.verdict, "consistent");
});

test("限州规则优先覆盖，导致双方无共同序列时冲突", () => {
  const rules: AddressRule[] = [
    { from: ["N", "Main"], to: ["North", "Maine"], state: "CA" },
    { from: ["N"], to: ["North"] },
    { from: ["Main", "St"], to: ["Main", "Street"] },
  ];
  const result = evaluateStore(
    profile({ street: "12 N Main St", state: "CA" }),
    profile({ street: "12 North Main Street", state: "CA" }),
    rules,
  );
  assert.equal(result.verdict, "conflict");
});

test("限州规则不适用于其他州", () => {
  const rules: AddressRule[] = [
    { from: ["N", "Main"], to: ["North", "Maine"], state: "NY" },
    { from: ["N"], to: ["North"] },
    { from: ["Main", "St"], to: ["Main", "Street"] },
  ];
  const result = evaluateStore(
    profile({ street: "12 N Main St", state: "CA" }),
    profile({ street: "12 North Main Street", state: "CA" }),
    rules,
  );
  assert.equal(result.verdict, "consistent");
});

test("重复规则与规则顺序不改变结果", () => {
  const base: AddressRule[] = [
    { from: ["St"], to: ["Street"] },
    { from: ["Ave"], to: ["Avenue"] },
  ];
  const shuffled: AddressRule[] = [
    { from: ["Ave"], to: ["Avenue"] },
    { from: ["St"], to: ["Street"] },
    { from: ["St"], to: ["Street"] },
  ];
  const canonical = profile({ street: "12 St" });
  const directory = profile({ street: "12 Street" });
  assert.equal(evaluateStore(canonical, directory, base).verdict, "consistent");
  assert.equal(
    evaluateStore(canonical, directory, shuffled).verdict,
    "consistent",
  );
});

test("标点不自动删除，St. 与 St 不相同", () => {
  const rules: AddressRule[] = [{ from: ["St"], to: ["Street"] }];
  const result = evaluateStore(
    profile({ street: "12 Main St." }),
    profile({ street: "12 Main Street" }),
    rules,
  );
  assert.equal(result.verdict, "conflict");
});

test("忽略 ASCII 大小写与多余空白", () => {
  const rules: AddressRule[] = [{ from: ["St"], to: ["Street"] }];
  const result = evaluateStore(
    profile({ street: "12   MAIN   ST" }),
    profile({ street: "12 main street" }),
    rules,
  );
  assert.equal(result.verdict, "consistent");
});

test("含数字词元的规则被拒绝", () => {
  const rules: AddressRule[] = [{ from: ["St"], to: ["Street1"] }];
  assert.throws(() =>
    evaluateStore(profile(), profile(), rules),
  );
});
