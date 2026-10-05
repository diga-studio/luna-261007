import { test } from "node:test";
import assert from "node:assert/strict";
import { bestInterpretations, tokenizeStreet } from "../src/index.js";
import type { AddressRule } from "../src/index.js";

test("替换输出不再参与规则", () => {
  const rules: AddressRule[] = [
    { from: ["A"], to: ["B"] },
    { from: ["B"], to: ["C"] },
  ];
  const best = bestInterpretations(tokenizeStreet("9 A"), rules, "CA");
  assert.deepEqual(
    best.map((interpretation) => interpretation.tokens),
    [["9", "b"]],
  );
});

test("同输入不同输出的解释全部保留", () => {
  const rules: AddressRule[] = [
    { from: ["St"], to: ["Street"] },
    { from: ["St"], to: ["Saint"] },
  ];
  const best = bestInterpretations(tokenizeStreet("12 St"), rules, "CA");
  assert.deepEqual(
    best.map((interpretation) => interpretation.tokens).sort(),
    [
      ["12", "saint"],
      ["12", "street"],
    ],
  );
});

test("优先级：限州覆盖优先于总覆盖", () => {
  const rules: AddressRule[] = [
    { from: ["N", "Main"], to: ["North", "Maine"], state: "CA" },
    { from: ["N"], to: ["North"] },
    { from: ["Main", "St"], to: ["Main", "Street"] },
  ];
  const best = bestInterpretations(
    tokenizeStreet("12 N Main St"),
    rules,
    "CA",
  );
  assert.deepEqual(
    best.map((interpretation) => interpretation.tokens),
    [["12", "north", "maine", "st"]],
  );
});

test("同覆盖时最小化规则数", () => {
  const rules: AddressRule[] = [
    { from: ["N", "Main"], to: ["North", "Main"] },
    { from: ["N"], to: ["North"] },
    { from: ["Main"], to: ["Main"] },
  ];
  const best = bestInterpretations(tokenizeStreet("12 N Main"), rules, "CA");
  assert.equal(best.length, 1);
  assert.deepEqual(best[0].tokens, ["12", "north", "main"]);
  assert.equal(best[0].ruleCount, 1);
});
