import test from "node:test";
import assert from "node:assert/strict";
import { transformBatch } from "../src/transform";
import { checkDefinition } from "../src/validate";
import type { MappingDefinition } from "../src/types";

const definition: MappingDefinition = {
  rules: [
    { source: ["id"], target: ["id"], transform: { kind: "copy" } },
    { source: ["profile", "hiredAt"], target: ["profile", "hiredAt"], transform: { kind: "date" } },
    { source: ["profile", "level"], target: ["profile", "level"], transform: { kind: "enum", values: ["L1", "L2"] } },
    { source: ["items", "*", "qty"], target: ["items", "*", "qty"], transform: { kind: "unit", numerator: "1", denominator: "1000", scale: 3 } },
    { source: ["items", "*", "sku"], target: ["items", "*", "sku"], transform: { kind: "copy" } },
    { source: ["items", "*", "note"], target: ["items", "*", "note"], transform: { kind: "copy" } },
  ],
};

assert.deepEqual(checkDefinition(definition), { ok: true });

test("keeps element positions and available fields amid missing, null and failed fields", () => {
  const records = [
    {
      id: "r1",
      profile: { hiredAt: "2024-03-10T08:30:00+08:00", level: "L2", extra: "dropped" },
      items: [
        { qty: "1500", sku: "A-1", note: "ok" },
        { qty: "bad", sku: "A-2" },
        { qty: null, sku: "A-3", note: null },
        {},
        "not-an-object",
      ],
    },
  ];
  const result = transformBatch(definition, records);
  assert.equal(result.records.length, 1);
  assert.deepEqual(result.records[0]?.output, {
    id: "r1",
    profile: { hiredAt: "2024-03-10T00:30:00.000Z", level: "L2" },
    items: [
      { qty: "1.500", sku: "A-1", note: "ok" },
      { sku: "A-2" },
      { qty: null, sku: "A-3", note: null },
      {},
      {},
    ],
  });
  assert.equal(result.errors.length, 1);
  const error = result.errors[0];
  assert.equal(error?.recordIndex, 0);
  assert.equal(error?.arrayIndex, 1);
  assert.deepEqual(error?.target, ["items", "*", "qty"]);
});

test("maps missing, null and empty source arrays to missing, null and empty targets", () => {
  const records = [
    { id: "no-items" },
    { id: "null-items", items: null },
    { id: "empty-items", items: [] },
  ];
  const result = transformBatch(definition, records);
  assert.deepEqual(result.records[0]?.output, { id: "no-items" });
  assert.deepEqual(result.records[1]?.output, { id: "null-items", items: null });
  assert.deepEqual(result.records[2]?.output, { id: "empty-items", items: [] });
  assert.equal(result.errors.length, 0);
});

test("keeps explicit null leaves without running the transform", () => {
  const records = [{ id: "r", profile: { hiredAt: null, level: null } }];
  const result = transformBatch(definition, records);
  assert.deepEqual(result.records[0]?.output, { id: "r", profile: { hiredAt: null, level: null } });
  assert.equal(result.errors.length, 0);
});

test("omits only the failed leaf and reports a locatable error", () => {
  const records = [
    { id: "ok", profile: { hiredAt: "2024-01-01T00:00:00Z", level: "L1" } },
    { id: "bad-date", profile: { hiredAt: "2024-02-30T00:00:00Z", level: "L1" } },
    { id: "bad-enum-case", profile: { hiredAt: "2024-01-01T00:00:00Z", level: "l1" } },
    { id: "bad-enum-number", profile: { hiredAt: "2024-01-01T00:00:00Z", level: 1 } },
  ];
  const result = transformBatch(definition, records);
  assert.deepEqual(result.records[0]?.output, {
    id: "ok",
    profile: { hiredAt: "2024-01-01T00:00:00.000Z", level: "L1" },
  });
  assert.deepEqual(result.records[1]?.output, { id: "bad-date", profile: { level: "L1" } });
  assert.deepEqual(result.records[2]?.output, {
    id: "bad-enum-case",
    profile: { hiredAt: "2024-01-01T00:00:00.000Z" },
  });
  assert.deepEqual(result.records[3]?.output, {
    id: "bad-enum-number",
    profile: { hiredAt: "2024-01-01T00:00:00.000Z" },
  });
  assert.equal(result.errors.length, 3);
  assert.deepEqual(
    result.errors.map((error) => [error.recordIndex, error.arrayIndex, error.target]),
    [
      [1, null, ["profile", "hiredAt"]],
      [2, null, ["profile", "level"]],
      [3, null, ["profile", "level"]],
    ],
  );
});

test("reports an error per rule when the array position holds a non-array", () => {
  const result = transformBatch(definition, [{ id: "x", items: "nope" }]);
  assert.deepEqual(result.records[0]?.output, { id: "x" });
  assert.equal(result.errors.length, 3);
  assert.ok(result.errors.every((error) => error.recordIndex === 0 && error.arrayIndex === null));
});

test("produces one output per record in the original order", () => {
  const records = [{ id: "a" }, null, { id: "c" }, 42];
  const result = transformBatch(definition, records);
  assert.deepEqual(result.records.map((record) => record.output), [
    { id: "a" },
    {},
    { id: "c" },
    {},
  ]);
});

function deepFreeze(value: unknown): unknown {
  if (typeof value === "object" && value !== null) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

test("does not mutate the definition or the source records", () => {
  const frozenDefinition = deepFreeze(JSON.parse(JSON.stringify(definition))) as MappingDefinition;
  const records = deepFreeze([
    { id: "r", profile: { hiredAt: "2024-01-01T00:00:00Z" }, items: [{ qty: "2", sku: "S" }] },
  ]) as unknown[];
  const result = transformBatch(frozenDefinition, records);
  assert.deepEqual(result.records[0]?.output, {
    id: "r",
    profile: { hiredAt: "2024-01-01T00:00:00.000Z" },
    items: [{ qty: "0.002", sku: "S" }],
  });
});

test("is not affected by previous batches with errors", () => {
  const good = [{ id: "g", profile: { level: "L1" }, items: [{ qty: "5", sku: "S" }] }];
  const bad = [{ id: "b", profile: { hiredAt: "not-a-date", level: "BAD" }, items: "broken" }];
  const first = transformBatch(definition, good);
  transformBatch(definition, bad);
  transformBatch(definition, bad);
  const second = transformBatch(definition, good);
  assert.deepEqual(second, first);
  assert.deepEqual(second.records[0]?.output, {
    id: "g",
    profile: { level: "L1" },
    items: [{ qty: "0.005", sku: "S" }],
  });
});

test("matches enum values exactly and case-sensitively", () => {
  const enumDefinition: MappingDefinition = {
    rules: [{ source: ["v"], target: ["v"], transform: { kind: "enum", values: ["1", "Active"] } }],
  };
  const result = transformBatch(enumDefinition, [
    { v: "1" },
    { v: 1 },
    { v: "Active" },
    { v: "active" },
  ]);
  assert.deepEqual(result.records.map((record) => record.output), [
    { v: "1" },
    {},
    { v: "Active" },
    {},
  ]);
  assert.equal(result.errors.length, 2);
});

test("transforms 1000 records x 20 elements x 30 mappings within 2 seconds", () => {
  const perfDefinition: MappingDefinition = {
    rules: [
      ...Array.from({ length: 10 }, (_, i) => ({
        source: ["f" + i],
        target: ["f" + i],
        transform: { kind: "copy" } as const,
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        source: ["items", "*", "g" + i],
        target: ["items", "*", "g" + i],
        transform: { kind: "copy" } as const,
      })),
      ...Array.from({ length: 5 }, (_, i) => ({
        source: ["items", "*", "u" + i],
        target: ["items", "*", "u" + i],
        transform: { kind: "unit", numerator: "3", denominator: "2", scale: 4 } as const,
      })),
      ...Array.from({ length: 5 }, (_, i) => ({
        source: ["items", "*", "e" + i],
        target: ["items", "*", "e" + i],
        transform: { kind: "enum", values: ["A", "B", "C"] } as const,
      })),
    ],
  };
  assert.deepEqual(checkDefinition(perfDefinition), { ok: true });
  const element: Record<string, unknown> = {};
  for (let i = 0; i < 10; i += 1) element["g" + i] = "x" + i;
  for (let i = 0; i < 5; i += 1) element["u" + i] = "123.456";
  for (let i = 0; i < 5; i += 1) element["e" + i] = "B";
  const record: Record<string, unknown> = { items: Array.from({ length: 20 }, () => ({ ...element })) };
  for (let i = 0; i < 10; i += 1) record["f" + i] = "v" + i;
  const records = Array.from({ length: 1000 }, () => record);

  const start = Date.now();
  const result = transformBatch(perfDefinition, records);
  const elapsed = Date.now() - start;
  assert.equal(result.records.length, 1000);
  assert.equal(result.errors.length, 0);
  assert.equal((result.records[999]?.output as { items: unknown[] }).items.length, 20);
  assert.ok(elapsed < 2000, `took ${elapsed}ms`);
});
