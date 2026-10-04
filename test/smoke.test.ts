import assert from "node:assert/strict";
import { test } from "node:test";
import { renderTemplate } from "../src/index.js";

test("skeleton compiles", () => {
  assert.equal(typeof renderTemplate, "function");
});
