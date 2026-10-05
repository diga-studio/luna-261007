import test from "node:test";
import assert from "node:assert/strict";
import { checkDefinition } from "../src/validate";
import type { MappingDefinition, MappingRule } from "../src/types";

function rule(source: string[], target: string[], transform: MappingRule["transform"] = { kind: "copy" }): MappingRule {
  return { source, target, transform };
}

function issuesOf(definition: MappingDefinition): readonly string[] {
  const result = checkDefinition(definition);
  assert.equal(result.ok, false);
  return (result as { issues: readonly { message: string }[] }).issues.map((issue) => issue.message);
}

test("accepts a valid definition with nested objects and one array level", () => {
  const definition: MappingDefinition = {
    rules: [
      rule(["id"], ["id"]),
      rule(["profile", "name"], ["profile", "name"]),
      rule(["items", "*", "amount"], ["items", "*", "amount"], {
        kind: "unit", numerator: "1", denominator: "100", scale: 2,
      }),
      rule(["items", "*", "status"], ["items", "*", "state"], {
        kind: "enum", values: ["A", "B"],
      }),
    ],
  };
  assert.deepEqual(checkDefinition(definition), { ok: true });
});

test("rejects duplicate target leaves", () => {
  const messages = issuesOf({
    rules: [rule(["a"], ["x"]), rule(["b"], ["x"])],
  });
  assert.ok(messages.some((message) => message.includes("already produced")));
});

test("rejects a position used as both leaf and container", () => {
  const messages = issuesOf({
    rules: [rule(["a"], ["x"]), rule(["b"], ["x", "y"])],
  });
  assert.ok(messages.length > 0);
  const messages2 = issuesOf({
    rules: [rule(["a"], ["x", "y"]), rule(["b"], ["x"])],
  });
  assert.ok(messages2.length > 0);
});

test("rejects a position used as both object and array container", () => {
  const messages = issuesOf({
    rules: [rule(["a"], ["x", "y"]), rule(["b", "*", "c"], ["x", "*", "z"])],
  });
  assert.ok(messages.some((message) => message.includes("object and array")));
});

test("rejects one target array fed by two source arrays", () => {
  const messages = issuesOf({
    rules: [
      rule(["a", "*", "v"], ["t", "*", "v"]),
      rule(["b", "*", "v"], ["t", "*", "w"]),
    ],
  });
  assert.ok(messages.some((message) => message.includes("more than one source array")));
});

test("allows one target array fed by several fields of the same source array", () => {
  const result = checkDefinition({
    rules: [
      rule(["a", "*", "v"], ["t", "*", "v"]),
      rule(["a", "*", "w"], ["t", "*", "w"]),
    ],
  });
  assert.deepEqual(result, { ok: true });
});

test("rejects array-level mismatch between source and target", () => {
  const messages = issuesOf({ rules: [rule(["a", "*", "v"], ["t", "v"])] });
  assert.ok(messages.some((message) => message.includes("both keep the array level")));
  const messages2 = issuesOf({ rules: [rule(["a", "v"], ["t", "*", "v"])] });
  assert.ok(messages2.some((message) => message.includes("both keep the array level")));
});

test("rejects paths crossing more than one array level", () => {
  const messages = issuesOf({
    rules: [rule(["a", "*", "b", "*", "v"], ["t", "*", "u", "*", "v"])],
  });
  assert.ok(messages.some((message) => message.includes("more than one array level")));
});

test("rejects invalid transform parameters", () => {
  const messages = issuesOf({
    rules: [
      rule(["a"], ["a"], { kind: "enum", values: [] }),
      rule(["b"], ["b"], { kind: "unit", numerator: "1.5", denominator: "2", scale: 2 }),
      rule(["c"], ["c"], { kind: "unit", numerator: "1", denominator: "0", scale: 2 }),
      rule(["d"], ["d"], { kind: "unit", numerator: "1", denominator: "-2", scale: 2 }),
      rule(["e"], ["e"], { kind: "unit", numerator: "1", denominator: "2", scale: 7 }),
      rule(["f"], ["f"], { kind: "bogus" } as unknown as MappingRule["transform"]),
    ],
  });
  assert.equal(messages.length, 6);
});

test("rejects malformed paths", () => {
  const messages = issuesOf({
    rules: [
      rule([], ["x"]),
      rule(["a"], []),
      { source: ["a"], target: ["y"], transform: { kind: "copy" } },
    ].map((r, i) => (i < 2 ? r : r)) as MappingRule[],
  });
  assert.equal(messages.length, 2);
});

test("rejects __proto__ segments in paths", () => {
  const messages = issuesOf({ rules: [rule(["a"], ["__proto__", "x"])] });
  assert.equal(messages.length, 1);
  const messages2 = issuesOf({ rules: [rule(["__proto__"], ["x"])] });
  assert.equal(messages2.length, 1);
});
