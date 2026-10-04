import assert from "node:assert/strict";
import { test } from "node:test";
import { renderTemplate } from "../src/index.js";
import type { TemplateContent } from "../src/index.js";

const content: TemplateContent = {
  tokens: { product: "default-product", cta: "buy now" },
  blocks: {
    headline: "Get {{product}} today",
    nested: {
      cta: "{{cta}}",
      price: 9.99,
      active: true,
      nothing: null,
    },
    list: ["{{product}}", "plain", 42],
  },
};

test("query param wins over default", () => {
  const out = renderTemplate(content, { product: "shoes" });
  assert.equal(out.headline, "Get shoes today");
});

test("missing param falls back to default", () => {
  const out = renderTemplate(content, {});
  assert.equal(out.headline, "Get default-product today");
  assert.equal((out.nested as Record<string, unknown>).cta, "buy now");
});

test("empty string is a valid param value", () => {
  const out = renderTemplate(content, { product: "" });
  assert.equal(out.headline, "Get  today");
});

test("replacement values are not re-interpreted as placeholders", () => {
  const tricky: TemplateContent = {
    tokens: { a: "x", b: "fallback" },
    blocks: { text: "{{a}} and {{b}}" },
  };
  const out = renderTemplate(tricky, { a: "{{b}}" });
  assert.equal(out.text, "{{b}} and fallback");
});

test("keys and non-string values stay untouched", () => {
  const out = renderTemplate(content, { product: "shoes", cta: "go" });
  const nested = out.nested as Record<string, unknown>;
  assert.equal(nested.price, 9.99);
  assert.equal(nested.active, true);
  assert.equal(nested.nothing, null);
  assert.deepEqual(Object.keys(out), ["headline", "nested", "list"]);
  assert.deepEqual(out.list, ["shoes", "plain", 42]);
});

test("multiple placeholders in one string", () => {
  const multi: TemplateContent = {
    tokens: { a: "1", b: "2" },
    blocks: { text: "{{a}}-{{b}}-{{a}}" },
  };
  assert.equal(renderTemplate(multi, { b: "B" }).text, "1-B-1");
});
