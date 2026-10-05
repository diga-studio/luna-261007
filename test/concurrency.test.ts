import { test } from "node:test";
import assert from "node:assert/strict";
import { openService } from "./helpers.js";
import { ConsentService, CATEGORIES, type Choices, type Snapshot, type WriteResult } from "../src/index.js";

const INITIAL: Choices = {
  cookies: "rejected",
  emailMarketing: "rejected",
  dataSharing: "rejected",
  personalization: "rejected",
};

test("同一用户 200 个并发调用（多实例）：结果可线性化，审计历史可还原每个修订号", async () => {
  const ctx = openService();
  try {
    const instanceB = new ConsentService({ path: ctx.dbPath });
    const snapshotsByRevision = new Map<number, Snapshot>();
    try {
      const services = [ctx.service, instanceB];
      const calls: Promise<WriteResult>[] = [];
      for (let i = 0; i < 200; i += 1) {
        const service = services[i % 2];
        const category = CATEGORIES[i % CATEGORIES.length];
        // 一半授权（基于陈旧快照，可能冲突），一半拒绝（总是成功）
        const value = i % 2 === 0 ? "granted" : "rejected";
        calls.push(
          Promise.resolve().then(() =>
            service.submitChoices("u1", {
              requestId: `concurrent-${i}`,
              baseRevision: 0,
              choices: { [category]: value },
            }),
          ),
        );
      }
      const results = await Promise.all(calls);
      for (const result of results) {
        if (result.status === "applied") {
          assert.ok(
            !snapshotsByRevision.has(result.snapshot.revision),
            "每个修订号至多一条成功命令",
          );
          snapshotsByRevision.set(result.snapshot.revision, result.snapshot);
        }
      }
    } finally {
      instanceB.close();
    }

    const applied = snapshotsByRevision.size;
    const history = ctx.service.getHistory("u1");
    assert.equal(history.length, applied, "事件数等于成功命令数");

    // 修订号必须从 1 开始连续递增（可线性化的一个推论）
    for (let i = 0; i < history.length; i += 1) {
      assert.equal(history[i].revision, i + 1);
    }

    // 从审计历史还原每个修订号的完整选择，与对应快照一致
    let reconstructed: Choices = { ...INITIAL };
    for (const event of history) {
      for (const category of event.touchedCategories) {
        reconstructed[category] = event.choicesAfter[category];
      }
      assert.deepEqual(
        event.choicesAfter,
        reconstructed,
        `修订号 ${event.revision} 的还原结果与事件快照不一致`,
      );
      const returned = snapshotsByRevision.get(event.revision);
      assert.ok(returned, `缺少修订号 ${event.revision} 对应的返回快照`);
      assert.deepEqual(
        returned.choices,
        reconstructed,
        `修订号 ${event.revision} 的返回快照与审计还原不一致`,
      );
    }

    // 当前快照与最后一个事件一致（当前状态与审计历史遵循同一顺序）
    const current = ctx.service.getSnapshot("u1");
    assert.equal(current.revision, history.length);
    assert.deepEqual(current.choices, reconstructed);
  } finally {
    ctx.cleanup();
  }
});

test("并发读写混合：读取到的快照内部一致（不混合不同修订号的类别值）", async () => {
  const ctx = openService();
  try {
    const tasks: Promise<unknown>[] = [];
    for (let i = 0; i < 100; i += 1) {
      tasks.push(
        Promise.resolve().then(() =>
          ctx.service.submitChoices("u2", {
            requestId: `mix-${i}`,
            baseRevision: 0,
            choices: { [CATEGORIES[i % 4]]: "rejected" },
          }),
        ),
      );
      tasks.push(
        Promise.resolve().then(() => {
          const snap = ctx.service.getSnapshot("u2");
          // 快照内部一致性：修订号 r 的快照必须等于历史上第 r 个事件的 choicesAfter
          const history = ctx.service.getHistory("u2");
          if (snap.revision === 0) {
            assert.deepEqual(snap.choices, INITIAL);
          } else {
            const event = history[snap.revision - 1];
            assert.equal(event.revision, snap.revision);
            assert.deepEqual(snap.choices, event.choicesAfter);
          }
        }),
      );
    }
    await Promise.all(tasks);
  } finally {
    ctx.cleanup();
  }
});
