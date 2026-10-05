import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBuilder, type Plan } from "../src/index.js";
import { allBytes, bytes, makeRun, tree } from "./helpers.js";

/**
 * 场景一：两个分支共用来源阶段。
 * 修改只被 branch-a COPY 选中的文件（以及一个无人选中的文件），
 * branch-a 重建、branch-b 不重建；逐字节验证二进制文件。
 */
test("two branches share source stage; unselected changes do not rebuild", async (t) => {
  const cacheDir = await mkdtemp(join(tmpdir(), "layer-cache-s1-"));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));

  const binary = allBytes();

  const plan = (baseCommand: string): Plan => ({
    stages: [
      { name: "base", steps: [{ type: "run", command: baseCommand }] },
      {
        name: "branch-a",
        steps: [
          { type: "copy", from: "base", src: "/dir-a", dest: "/app" },
          { type: "copy", src: "/assets/logo.bin", dest: "/app/logo.bin" },
          { type: "run", command: "run-a" },
        ],
      },
      {
        name: "branch-b",
        steps: [
          { type: "copy", from: "base", src: "/dir-b", dest: "/app" },
          { type: "run", command: "run-b" },
        ],
      },
    ],
  });

  const context = tree({ "/assets/logo.bin": binary });

  const run = makeRun({
    "base-v1": () => ({
      writes: {
        "/dir-a/value.txt": bytes("a1"),
        "/dir-b/value.txt": bytes("b1"),
        "/other/junk.txt": bytes("junk1"),
      },
      deletes: [],
    }),
    "base-v2": () => ({
      writes: {
        "/dir-a/value.txt": bytes("a2"), // 仅被 branch-a 选中，变了
        "/dir-b/value.txt": bytes("b1"), // 被 branch-b 选中，没变
        "/other/junk.txt": bytes("junk2"), // 无人选中，变了
      },
      deletes: [],
    }),
    "run-a": () => ({ writes: { "/app/a.out": bytes("out-a") }, deletes: [] }),
    "run-b": () => ({ writes: { "/app/b.out": bytes("out-b") }, deletes: [] }),
  });

  const builder = createBuilder({ cacheDir, run: run.fn });

  // 首次构建两个分支
  const imageA1 = await builder.build(plan("base-v1"), context, "branch-a");
  const imageB1 = await builder.build(plan("base-v1"), context, "branch-b");
  assert.equal(run.count("base-v1"), 1, "base 只执行一次（两分支共享）");
  assert.equal(run.count("run-a"), 1);
  assert.equal(run.count("run-b"), 1);
  assert.equal(run.total(), 3);

  // 逐字节验证二进制文件
  const logo = await builder.readFile(imageA1, "/app/logo.bin");
  assert.ok(logo !== undefined);
  assert.equal(logo.length, 256);
  for (let i = 0; i < 256; i++) assert.equal(logo[i], i);
  assert.deepEqual(logo, binary);

  // 修改来源阶段：仅 branch-a 选中的文件 + 无人选中的文件变化
  const imageA2 = await builder.build(plan("base-v2"), context, "branch-a");
  const imageB2 = await builder.build(plan("base-v2"), context, "branch-b");

  assert.equal(run.count("base-v2"), 1, "新 base 命令执行一次");
  assert.equal(run.count("run-a"), 2, "branch-a 的 RUN 输入变了，重新执行");
  assert.equal(run.count("run-b"), 1, "branch-b 的 RUN 输入未变，不得重建");
  assert.equal(run.total(), 5);

  assert.notEqual(imageA1, imageA2, "branch-a 最终树变了，imageId 不同");
  assert.equal(imageB1, imageB2, "branch-b 最终树不变，imageId 相同");

  assert.deepEqual(await builder.readFile(imageA2, "/app/value.txt"), bytes("a2"));
  assert.deepEqual(await builder.readFile(imageB2, "/app/value.txt"), bytes("b1"));
  assert.deepEqual(await builder.readFile(imageA2, "/app/logo.bin"), binary);
});
