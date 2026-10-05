import { test } from "node:test";
import assert from "node:assert/strict";
import { TemplateStore } from "../src/templateStore.js";

const BASELINE = "baseline-text";

const echoRenderer = async (nodeId: string, text: string) =>
  `${nodeId}:${text}`;

async function renderMap(store: TemplateStore, nodeIds: string[]) {
  return store.render(nodeIds, echoRenderer);
}

test("render falls back to baseline when no batch covers a node", async () => {
  const store = new TemplateStore(BASELINE);
  const result = await renderMap(store, ["n1", "n2"]);
  assert.equal(result.get("n1"), `n1:${BASELINE}`);
  assert.equal(result.get("n2"), `n2:${BASELINE}`);
});

test("overlapping batches: withdraw A then B returns to baseline", async () => {
  const store = new TemplateStore(BASELINE);
  const v1 = store.publish("text-v1");
  const v2 = store.publish("text-v2");
  store.rollout("batchA", v1, ["n1", "n2", "n3"], 100);
  store.rollout("batchB", v2, ["n2", "n3", "n4"], 100);

  let result = await renderMap(store, ["n1", "n2", "n3", "n4"]);
  assert.equal(result.get("n1"), "n1:text-v1");
  assert.equal(result.get("n2"), "n2:text-v2");
  assert.equal(result.get("n3"), "n3:text-v2");
  assert.equal(result.get("n4"), "n4:text-v2");

  store.withdraw("batchA");
  result = await renderMap(store, ["n1", "n2", "n3", "n4"]);
  assert.equal(result.get("n1"), `n1:${BASELINE}`);
  assert.equal(result.get("n2"), "n2:text-v2");
  assert.equal(result.get("n3"), "n3:text-v2");

  store.withdraw("batchB");
  result = await renderMap(store, ["n1", "n2", "n3", "n4"]);
  for (const id of ["n1", "n2", "n3", "n4"]) {
    assert.equal(result.get(id), `${id}:${BASELINE}`);
  }
});

test("overlapping batches: withdraw B first exposes still-active A", async () => {
  const store = new TemplateStore(BASELINE);
  const v1 = store.publish("text-v1");
  const v2 = store.publish("text-v2");
  store.rollout("batchA", v1, ["n1", "n2", "n3"], 100);
  store.rollout("batchB", v2, ["n2", "n3", "n4"], 100);

  store.withdraw("batchB");
  const result = await renderMap(store, ["n1", "n2", "n3", "n4"]);
  assert.equal(result.get("n1"), "n1:text-v1");
  assert.equal(result.get("n2"), "n2:text-v1");
  assert.equal(result.get("n3"), "n3:text-v1");
  assert.equal(result.get("n4"), `n4:${BASELINE}`);

  store.withdraw("batchA");
  const after = await renderMap(store, ["n1", "n2", "n3", "n4"]);
  for (const id of ["n1", "n2", "n3", "n4"]) {
    assert.equal(after.get(id), `${id}:${BASELINE}`);
  }
});

test("withdraw is idempotent", async () => {
  const store = new TemplateStore(BASELINE);
  const v1 = store.publish("text-v1");
  store.rollout("batchA", v1, ["n1"], 100);
  store.withdraw("batchA");
  store.withdraw("batchA");
  const result = await renderMap(store, ["n1"]);
  assert.equal(result.get("n1"), `n1:${BASELINE}`);
});

test("rollout retry with same params returns original members", () => {
  const store = new TemplateStore(BASELINE);
  const v1 = store.publish("text-v1");
  const nodes = ["n1", "n2", "n3", "n4", "n5"];
  const first = store.rollout("batchA", v1, nodes, 50);
  const second = store.rollout("batchA", v1, nodes, 50);
  assert.deepEqual(second, first);
});

test("rollout retry after withdraw does not revive the batch", async () => {
  const store = new TemplateStore(BASELINE);
  const v1 = store.publish("text-v1");
  const nodes = ["n1", "n2", "n3"];
  const first = store.rollout("batchA", v1, nodes, 100);
  store.withdraw("batchA");
  const retried = store.rollout("batchA", v1, nodes, 100);
  assert.deepEqual(retried, first);
  const result = await renderMap(store, nodes);
  for (const id of nodes) {
    assert.equal(result.get(id), `${id}:${BASELINE}`);
  }
});

test("rollout with same batchId but different params throws", () => {
  const store = new TemplateStore(BASELINE);
  const v1 = store.publish("text-v1");
  const v2 = store.publish("text-v2");
  store.rollout("batchA", v1, ["n1", "n2"], 50);
  assert.throws(() => store.rollout("batchA", v2, ["n1", "n2"], 50));
  assert.throws(() => store.rollout("batchA", v1, ["n1", "n2"], 25));
  assert.throws(() => store.rollout("batchA", v1, ["n1", "n3"], 50));
});

test("selection is independent of input order", () => {
  const nodes = Array.from({ length: 20 }, (_, i) => `n${i}`);
  const shuffled = [...nodes].reverse();
  const a = new TemplateStore(BASELINE);
  const b = new TemplateStore(BASELINE);
  const va = a.publish("t");
  const vb = b.publish("t");
  const ra = a.rollout("batch", va, nodes, 50);
  const rb = b.rollout("batch", vb, shuffled, 50);
  assert.deepEqual(ra, rb);
});

test("percentage selections are nested", () => {
  const nodes = Array.from({ length: 40 }, (_, i) => `n${i}`);
  const store = new TemplateStore(BASELINE);
  const v = store.publish("t");
  const p10 = store.rollout("b10", v, nodes, 10);
  const p25 = store.rollout("b25", v, nodes, 25);
  const p50 = store.rollout("b50", v, nodes, 50);
  const p100 = store.rollout("b100", v, nodes, 100);
  assert.equal(p10.length, 4);
  assert.equal(p25.length, 10);
  assert.equal(p50.length, 20);
  assert.equal(p100.length, 40);
  const s25 = new Set(p25);
  const s50 = new Set(p50);
  const s100 = new Set(p100);
  assert.ok(p10.every((id) => s25.has(id)));
  assert.ok(p25.every((id) => s50.has(id)));
  assert.ok(p50.every((id) => s100.has(id)));
});

test("selection rounds up", () => {
  const store = new TemplateStore(BASELINE);
  const v = store.publish("t");
  const members = store.rollout("b", v, ["n1", "n2", "n3"], 25);
  assert.equal(members.length, 1);
});

test("override order follows batch creation, not publish time", async () => {
  const store = new TemplateStore(BASELINE);
  const vNew = store.publish("text-new");
  const vOld = store.publish("text-old");
  store.rollout("batchNew", vNew, ["n1"], 100);
  store.rollout("batchOld", vOld, ["n1"], 100);
  const result = await renderMap(store, ["n1"]);
  assert.equal(result.get("n1"), "n1:text-old");
});

test("renderer is caller-injected and receives node id and text", async () => {
  const store = new TemplateStore(BASELINE);
  const v = store.publish("hello");
  store.rollout("b", v, ["n1"], 100);
  const calls: Array<[string, string]> = [];
  const result = await store.render(["n1", "n2"], async (nodeId, text) => {
    calls.push([nodeId, text]);
    return `<${text}>`;
  });
  assert.deepEqual(calls.sort(), [
    ["n1", "hello"],
    ["n2", BASELINE],
  ]);
  assert.equal(result.get("n1"), "<hello>");
  assert.equal(result.get("n2"), `<${BASELINE}>`);
});

test("invalid percentage and unknown version are rejected", () => {
  const store = new TemplateStore(BASELINE);
  const v = store.publish("t");
  assert.throws(() => store.rollout("b1", v, ["n1"], 30 as never));
  assert.throws(() => store.rollout("b2", "nope", ["n1"], 50));
});
