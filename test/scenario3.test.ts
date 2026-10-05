import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBuilder, type Plan } from "../src/index.js";
import { bytes, makeRun, tree } from "./helpers.js";

/** RUN 的删除效果在缓存命中后完整还原（跨实例） */
test("cached run restores deletes, not just writes", async (t) => {
  const cacheDir = await mkdtemp(join(tmpdir(), "layer-cache-s3a-"));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));

  const plan: Plan = {
    stages: [
      {
        name: "main",
        steps: [
          { type: "copy", src: "/src", dest: "/work" },
          { type: "run", command: "cleanup" },
        ],
      },
    ],
  };
  const context = tree({
    "/src/keep.txt": bytes("keep"),
    "/src/temp.txt": bytes("temp"),
  });
  const handlers = {
    cleanup: () => ({
      writes: { "/work/built.out": bytes("built") },
      deletes: ["/work/temp.txt"],
    }),
  };

  const run1 = makeRun(handlers);
  const builder1 = createBuilder({ cacheDir, run: run1.fn });
  const image1 = await builder1.build(plan, context, "main");
  assert.equal(run1.total(), 1);
  assert.equal(await builder1.readFile(image1, "/work/temp.txt"), undefined);
  assert.deepEqual(await builder1.readFile(image1, "/work/keep.txt"), bytes("keep"));

  // 新实例命中缓存：删除效果必须还原
  const run2 = makeRun(handlers);
  const builder2 = createBuilder({ cacheDir, run: run2.fn });
  const image2 = await builder2.build(plan, context, "main");
  assert.equal(run2.total(), 0, "命中缓存，不调用 run");
  assert.equal(image2, image1);
  assert.equal(
    await builder2.readFile(image2, "/work/temp.txt"),
    undefined,
    "删除效果被还原",
  );
  assert.deepEqual(await builder2.readFile(image2, "/work/keep.txt"), bytes("keep"));
  assert.deepEqual(await builder2.readFile(image2, "/work/built.out"), bytes("built"));
});

/** 阶段改名、独立阶段重排不造成缓存失效 */
test("stage rename and reorder of independent stages keep cache", async (t) => {
  const cacheDir = await mkdtemp(join(tmpdir(), "layer-cache-s3b-"));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));

  const context = tree({ "/x.txt": bytes("x") });
  const handlers = {
    "cmd-one": () => ({ writes: { "/one.out": bytes("1") }, deletes: [] }),
    "cmd-two": () => ({ writes: { "/two.out": bytes("2") }, deletes: [] }),
  };

  const planA: Plan = {
    stages: [
      {
        name: "first",
        steps: [
          { type: "copy", src: "/x.txt", dest: "/x.txt" },
          { type: "run", command: "cmd-one" },
        ],
      },
      { name: "second", steps: [{ type: "run", command: "cmd-two" }] },
    ],
  };
  // second 重排到前面；first 改名为 renamed；target 也随之改名
  const planB: Plan = {
    stages: [
      { name: "second", steps: [{ type: "run", command: "cmd-two" }] },
      {
        name: "renamed",
        steps: [
          { type: "copy", src: "/x.txt", dest: "/x.txt" },
          { type: "run", command: "cmd-one" },
        ],
      },
    ],
  };

  const run = makeRun(handlers);
  const builder = createBuilder({ cacheDir, run: run.fn });
  const imageA = await builder.build(planA, context, "first");
  assert.equal(run.total(), 1, "只执行目标阶段，独立的 second 不执行");
  await builder.build(planA, context, "second");
  assert.equal(run.total(), 2);

  const imageB = await builder.build(planB, context, "renamed");
  await builder.build(planB, context, "second");
  assert.equal(run.total(), 2, "改名与重排后全部命中，不再调用 run");
  assert.equal(imageA, imageB, "最终树相同，imageId 相同");
});

/** readFile 对未知镜像 / 未知路径返回 undefined */
test("readFile returns undefined for unknown image or path", async (t) => {
  const cacheDir = await mkdtemp(join(tmpdir(), "layer-cache-s3c-"));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));

  const run = makeRun({});
  const builder = createBuilder({ cacheDir, run: run.fn });
  const plan: Plan = {
    stages: [{ name: "only", steps: [{ type: "copy", src: "/a.txt", dest: "/a.txt" }] }],
  };
  const imageId = await builder.build(plan, tree({ "/a.txt": bytes("a") }), "only");
  assert.equal(await builder.readFile("0".repeat(64), "/a.txt"), undefined);
  assert.equal(await builder.readFile(imageId, "/missing.txt"), undefined);
  assert.deepEqual(await builder.readFile(imageId, "a.txt"), bytes("a"));
});
