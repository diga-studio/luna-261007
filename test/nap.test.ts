import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { judgeNap, tokenize, validInterpretations } from "../src/index.js";
import type { AddressRule, NapRecord } from "../src/index.js";

function record(overrides: Partial<NapRecord> = {}): NapRecord {
  return {
    name: "ACME STORE",
    phone: "+1-555-0100",
    city: "SPRINGFIELD",
    state: "IL",
    zip: "62701",
    unit: null,
    street: "12 N Main St",
    ...overrides,
  };
}

test("tokenize 仅忽略 ASCII 大小写与多余空白，保留标点", () => {
  deepEqual(tokenize("  12  N\tMain St. "), ["12", "n", "main", "st."]);
  deepEqual(tokenize(""), []);
});

test("目录资料为空时判定为缺失", () => {
  equal(judgeNap(record(), null, []).verdict, "missing");
});

test("名称、电话、城市、州、邮编任一不同即为冲突", () => {
  for (const field of ["name", "phone", "city", "state", "zip"] as const) {
    const directory = record({ [field]: "DIFFERENT" });
    const judgment = judgeNap(record(), directory, []);
    equal(judgment.verdict, "conflict", field);
    deepEqual(judgment.conflictFields, [field]);
  }
});

test("一侧有单元号而另一侧没有即为冲突", () => {
  const judgment = judgeNap(record(), record({ unit: "STE 200" }), []);
  equal(judgment.verdict, "conflict");
  deepEqual(judgment.conflictFields, ["unit"]);
});

test("无规则且街道相同判定为一致", () => {
  equal(judgeNap(record(), record(), []).verdict, "consistent");
});

test("St 同时可改为 Street 与 Saint 时，12 St 与 12 Street 必须待核验", () => {
  const rules: AddressRule[] = [
    { state: null, input: ["St"], output: ["Street"] },
    { state: null, input: ["St"], output: ["Saint"] },
  ];
  const judgment = judgeNap(
    record({ street: "12 St" }),
    record({ street: "12 Street" }),
    rules,
  );
  equal(judgment.verdict, "needs_review");
  ok(judgment.evidence);
  deepEqual(judgment.evidence.commonSequence, ["12", "street"]);
  deepEqual(judgment.evidence.canonicalSequence, ["12", "saint"]);
  deepEqual(judgment.evidence.directorySequence, ["12", "street"]);
});

test("覆盖重叠规则：12 N Main St 与 12 North Main Street 必须一致", () => {
  const rules: AddressRule[] = [
    { state: null, input: ["N", "Main"], output: ["North", "Main"] },
    { state: null, input: ["N"], output: ["North"] },
    { state: null, input: ["Main", "St"], output: ["Main", "Street"] },
  ];
  const judgment = judgeNap(record(), record({ street: "12 North Main Street" }), rules);
  equal(judgment.verdict, "consistent");
});

test("限州规则优先且输出为 North Maine 时，同一地址对必须冲突", () => {
  const rules: AddressRule[] = [
    { state: "IL", input: ["N", "Main"], output: ["North", "Maine"] },
    { state: null, input: ["N"], output: ["North"] },
    { state: null, input: ["Main", "St"], output: ["Main", "Street"] },
  ];
  const judgment = judgeNap(record(), record({ street: "12 North Main Street" }), rules);
  equal(judgment.verdict, "conflict");
  deepEqual(judgment.conflictFields, ["street"]);
});

test("规则顺序与重复规则不改变判定结果", () => {
  const base: AddressRule[] = [
    { state: null, input: ["St"], output: ["Street"] },
    { state: null, input: ["St"], output: ["Saint"] },
  ];
  const shuffled: AddressRule[] = [base[1], base[0], base[0], base[1]];
  const canonical = record({ street: "12 St" });
  const directory = record({ street: "12 Street" });
  deepEqual(judgeNap(canonical, directory, shuffled), judgeNap(canonical, directory, base));
});

test("限州规则不适用于其他州", () => {
  const rules: AddressRule[] = [
    { state: "CA", input: ["St"], output: ["Street"] },
  ];
  deepEqual(validInterpretations(["12", "st"], "IL", rules), [["12", "st"]]);
});

test("规则输出为空或含数字词元时抛错", () => {
  const empty: AddressRule[] = [{ state: null, input: ["St"], output: [] }];
  const digit: AddressRule[] = [{ state: null, input: ["St"], output: ["Apt 2"] }];
  const canonical = record({ street: "12 St" });
  const directory = record({ street: "12 St" });
  let threw = 0;
  for (const rules of [empty, digit]) {
    try {
      judgeNap(canonical, directory, rules);
    } catch {
      threw += 1;
    }
  }
  equal(threw, 2);
});
