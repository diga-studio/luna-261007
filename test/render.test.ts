import { test } from "node:test";
import assert from "node:assert/strict";
import { renderTemplate } from "../src/index";
import type { Template } from "../src/index";

const template: Template = {
  blocks: {
    headline: "Buy {{product}} now",
    nested: {
      lines: ["{{product}} & {{gift}}", 42, true, null],
      price: 9.99,
    },
    list: ["{{missing}}"],
    "literal {{key}}": "key names stay {{product}}",
  },
  tokens: {
    product: { default: "shoes" },
    gift: { default: "socks" },
    missing: { default: "fallback" },
  },
};

test("同名查询参数优先，缺失时使用默认值", () => {
  const out = renderTemplate(template, { product: "boots" }) as any;
  assert.equal(out.headline, "Buy boots now");
  assert.equal(out.nested.lines[0], "boots & socks");
  assert.equal(out.list[0], "fallback");
});

test("空字符串是有效值", () => {
  const out = renderTemplate(template, { product: "" }) as any;
  assert.equal(out.headline, "Buy  now");
});

test("替换值不再次解释为占位符", () => {
  const out = renderTemplate(template, { product: "{{gift}}" }) as any;
  assert.equal(out.headline, "Buy {{gift}} now");
});

test("键名及非字符串值保持不变", () => {
  const out = renderTemplate(template, {}) as any;
  assert.deepEqual(Object.keys(out), Object.keys(template.blocks as object));
  assert.ok("literal {{key}}" in out);
  assert.equal(out.nested.lines[1], 42);
  assert.equal(out.nested.lines[2], true);
  assert.equal(out.nested.lines[3], null);
  assert.equal(out.nested.price, 9.99);
});

test("同一字符串中多个占位符都被替换", () => {
  const t: Template = {
    blocks: { text: "{{a}}-{{b}}-{{a}}" },
    tokens: { a: { default: "x" }, b: { default: "y" } },
  };
  const out = renderTemplate(t, { b: "B" }) as any;
  assert.equal(out.text, "x-B-x");
});
