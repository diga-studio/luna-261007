import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBuilder, type Plan } from "../src/index.js";
import { bytes, makeRun, tree } from "./helpers.js";

/**
 * 场景二：更换来源 RUN 命令但输出树相同，下游不重建；
 * 再换命令使选中目录少一个文件，下游失效且最终文件缺失；
 * 重建实例后再次构建不调用 run 且输出可读。
 */
test("same-output command change keeps downstream cache; shrinking output invalidates", async (t) => {
  const cacheDir = await mkdtemp(join(tmpdir(), "layer-cache-s2-"));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));

  const plan = (srcCommand: string): Plan => ({
    stages: [
      { name: "src", steps: [{ type: "run", command: srcCommand }] },
      {
        name: "down",
        steps: [
          { type: "copy", from: "src", src: "/data", dest: "/srv" },
          { type: "run", command: "downstream" },
        ],
      },
    ],
  });

  const context = tree({});

  const run = makeRun({
    "src-v1": () => ({
      writes: { "/data/a.txt": bytes("A"), "/data/b.txt": bytes("B") },
      deletes: [],
    }),
    // 命令不同，输出树完全相同
    "src-v2": () => ({
      writes: { "/data/a.txt": bytes("A"), "/data/b.txt": bytes("B") },
      deletes: [],
    }),
    // 选中目录少一个文件
    "src-v3": () => ({
      writes: { "/data/a.txt": bytes("A") },
      deletes: [],
    }),
    downstream: () => ({ writes: { "/srv/result.out": bytes("done") }, deletes: [] }),
  });

  const builder = createBuilder({ cacheDir, run: run.fn });

  const image1 = await builder.build(plan("src-v1"), context, "down");
  assert.equal(run.total(), 2, "src-v1 与 downstream 各执行一次");

  // 换命令但输出树相同：src 重跑，下游命中
  const image2 = await builder.build(plan("src-v2"), context, "down");
  assert.equal(run.count("src-v2"), 1, "新命令必须执行");
  assert.equal(run.count("downstream"), 1, "下游输入树相同，不得重建");
  assert.equal(image1, image2, "最终树相同，imageId 相同");

  // 换命令使选中目录少一个文件：下游失效
  const image3 = await builder.build(plan("src-v3"), context, "down");
  assert.equal(run.count("src-v3"), 1);
  assert.equal(run.count("downstream"), 2, "下游输入树变了，重新执行");
  assert.notEqual(image2, image3);

  assert.deepEqual(await builder.readFile(image3, "/srv/a.txt"), bytes("A"));
  assert.equal(
    await builder.readFile(image3, "/srv/b.txt"),
    undefined,
    "少掉的文件在最终镜像中缺失",
  );
  assert.deepEqual(await builder.readFile(image3, "/srv/result.out"), bytes("done"));

  // 重新创建实例：缓存跨实例保留，不再调用 run，输出仍可读
  const run2 = makeRun({
    "src-v3": () => ({ writes: {}, deletes: [] }),
    downstream: () => ({ writes: {}, deletes: [] }),
  });
  const builder2 = createBuilder({ cacheDir, run: run2.fn });
  const image4 = await builder2.build(plan("src-v3"), context, "down");
  assert.equal(run2.total(), 0, "缓存命中，不调用 run");
  assert.equal(image4, image3, "相同最终树产生相同 imageId");
  assert.deepEqual(await builder2.readFile(image4, "/srv/a.txt"), bytes("A"));
  assert.equal(await builder2.readFile(image4, "/srv/b.txt"), undefined);
  assert.deepEqual(await builder2.readFile(image4, "/srv/result.out"), bytes("done"));
});
