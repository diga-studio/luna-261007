import { test } from "node:test";
import assert from "node:assert/strict";
import { GrayTemplateStore, type Renderer } from "../src/index.ts";

const echoRenderer: Renderer = async (nodeId, text) => `${nodeId}<-${text}`;

function texts(map: Map<string, string>): string[] {
  return [...map.values()];
}

test("render falls back to baseline when no batch covers a node", async () => {
  const store = new GrayTemplateStore({ baselineText: "base" });
  const result = await store.render(["a", "b"], echoRenderer);
  assert.deepEqual(texts(result), ["a<-base", "b<-base"]);
});

test("selection is input-order independent and nested across percentages", () => {
  const nodes = Array.from({ length: 40 }, (_, i) => `node-${i}`);
  const shuffled = [...nodes].reverse();

  const s1 = new GrayTemplateStore({ baselineText: "base" });
  const s2 = new GrayTemplateStore({ baselineText: "base" });
  const v1 = s1.publish("x");
  const v2 = s2.publish("x");

  const p50a = s1.rollout("b", v1, nodes, 50);
  const p50b = s2.rollout("b", v2, shuffled, 50);
  assert.deepEqual([...p50a].sort(), [...p50b].sort());

  const p10 = s1.rollout("b10", v1, nodes, 10);
  const p25 = s1.rollout("b25", v1, nodes, 25);
  const p100 = s1.rollout("b100", v1, nodes, 100);
  assert.equal(p10.length, 4);
  assert.equal(p25.length, 10);
  assert.equal(p50a.length, 20);
  assert.equal(p100.length, 40);
  for (const id of p10) assert.ok(p25.includes(id));
  for (const id of p25) assert.ok(p50a.includes(id));
  for (const id of p50a) assert.ok(p100.includes(id));
});

test("member count rounds up", () => {
  const store = new GrayTemplateStore({ baselineText: "base" });
  const v = store.publish("x");
  const nodes = ["a", "b", "c"];
  assert.equal(store.rollout("b1", v, nodes, 10).length, 1);
  assert.equal(store.rollout("b2", v, nodes, 25).length, 1);
  assert.equal(store.rollout("b3", v, nodes, 50).length, 2);
});

test("overlapping batches: withdraw A then B returns to baseline", async () => {
  const store = new GrayTemplateStore({ baselineText: "base" });
  const v1 = store.publish("one");
  const v2 = store.publish("two");
  const aMembers = store.rollout("A", v1, ["n1", "n2", "n3"], 100);
  const bMembers = store.rollout("B", v2, ["n2", "n3", "n4"], 100);
  assert.deepEqual(aMembers.sort(), ["n1", "n2", "n3"]);
  assert.deepEqual(bMembers.sort(), ["n2", "n3", "n4"]);

  store.withdraw("A");
  let result = await store.render(["n1", "n2", "n4"], echoRenderer);
  assert.deepEqual(texts(result), ["n1<-base", "n2<-two", "n4<-two"]);

  store.withdraw("B");
  result = await store.render(["n1", "n2", "n3", "n4"], echoRenderer);
  assert.deepEqual(
    texts(result),
    ["n1<-base", "n2<-base", "n3<-base", "n4<-base"]
  );
});

test("overlapping batches: withdraw B first reveals still-active A", async () => {
  const store = new GrayTemplateStore({ baselineText: "base" });
  const v1 = store.publish("one");
  const v2 = store.publish("two");
  store.rollout("A", v1, ["n1", "n2", "n3"], 100);
  store.rollout("B", v2, ["n2", "n3", "n4"], 100);

  store.withdraw("B");
  const result = await store.render(["n1", "n2", "n3", "n4"], echoRenderer);
  assert.deepEqual(
    texts(result),
    ["n1<-one", "n2<-one", "n3<-one", "n4<-base"]
  );

  store.withdraw("A");
  const after = await store.render(["n1", "n2"], echoRenderer);
  assert.deepEqual(texts(after), ["n1<-base", "n2<-base"]);
});

test("rollout retry with same batchId returns original batch without reselecting", async () => {
  const store = new GrayTemplateStore({ baselineText: "base" });
  const v1 = store.publish("one");
  const v2 = store.publish("two");
  const nodes = Array.from({ length: 20 }, (_, i) => `n${i}`);

  const first = store.rollout("B", v1, nodes, 50);
  const retry = store.rollout("B", v1, nodes, 50);
  assert.deepEqual(retry, first);

  const retryOtherVersion = store.rollout("B", v2, nodes, 100);
  assert.deepEqual(retryOtherVersion, first);

  const result = await store.render(first, echoRenderer);
  assert.ok(texts(result).every((t) => t.endsWith("<-one")));
});

test("withdraw is idempotent and retry after withdraw does not revive", async () => {
  const store = new GrayTemplateStore({ baselineText: "base" });
  const v1 = store.publish("one");
  store.rollout("B", v1, ["n1", "n2"], 100);

  store.withdraw("B");
  store.withdraw("B");
  let result = await store.render(["n1"], echoRenderer);
  assert.deepEqual(texts(result), ["n1<-base"]);

  const retry = store.rollout("B", v1, ["n1", "n2"], 100);
  assert.deepEqual(retry.sort(), ["n1", "n2"]);
  result = await store.render(["n1", "n2"], echoRenderer);
  assert.deepEqual(texts(result), ["n1<-base", "n2<-base"]);
});

test("later batch overrides earlier one regardless of publish time", async () => {
  const store2 = new GrayTemplateStore({ baselineText: "base" });
  const a = store2.publish("new");
  store2.rollout("first", a, ["n1"], 100);
  const b = store2.publish("older-text");
  store2.rollout("second", b, ["n1"], 100);
  const result = await store2.render(["n1"], echoRenderer);
  assert.deepEqual(texts(result), ["n1<-older-text"]);
});

test("unknown version or batch raises", () => {
  const store = new GrayTemplateStore({ baselineText: "base" });
  assert.throws(() => store.rollout("B", "nope", ["n1"], 50));
  assert.throws(() => store.withdraw("nope"));
  const v = store.publish("x");
  assert.throws(() => store.rollout("B2", v, ["n1"], 30 as 25));
});
