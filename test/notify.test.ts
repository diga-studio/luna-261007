import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalReceiver, NotificationQueue } from "../src/index.js";
import type { DeliveryBehavior } from "../src/index.js";

interface World {
  queue: NotificationQueue;
  receiver: LocalReceiver;
}

function openWorld(dir: string, behavior: DeliveryBehavior): World {
  const receiver = new LocalReceiver({
    dbPath: join(dir, "receiver.db"),
    behavior,
  });
  const queue = new NotificationQueue({
    dbPath: join(dir, "queue.db"),
    receiver,
  });
  return { queue, receiver };
}

function closeWorld(world: World): void {
  world.queue.close();
  world.receiver.close();
}

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "notify-test-"));
}

test("成功结果已落地但队列未确认时退出，重复恢复后收件箱仍只有一条消息", async () => {
  const dir = makeDir();
  try {
    let world = openWorld(dir, () => true);
    world.queue.enqueue("n1", "hello", 1000);
    // 接收方已保存成功结果与消息，但队列尚未确认就“进程退出”
    await world.receiver.deliver("n1", 1, "hello", 1000);
    closeWorld(world);

    // 多次重启恢复：结果不重复落地，消息不重复生成
    for (let round = 0; round < 3; round += 1) {
      world = openWorld(dir, () => true);
      await world.queue.advance(1000);
      const state = world.queue.getStatus("n1");
      ok(state);
      equal(state!.status, "delivered");
      equal(state!.attempts, 1);
      equal(world.receiver.messageCount(), 1);
      equal(world.receiver.getMessage("n1"), "hello");
      closeWorld(world);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("失败结果已落地但未返回时退出，恢复后按原时间退避，第5次失败后停止", async () => {
  const dir = makeDir();
  try {
    let world = openWorld(dir, () => false);
    world.queue.enqueue("n1", "msg", 0);
    // 第1次失败结果落地于 t=0，投递尚未返回就“进程退出”
    await world.receiver.deliver("n1", 1, "msg", 0);
    closeWorld(world);

    world = openWorld(dir, () => false);
    await world.queue.advance(500); // 恢复：采用落地结果，退避从落地时间 0 起算
    let state = world.queue.getStatus("n1")!;
    equal(state.status, "queued");
    equal(state.attempts, 1);
    equal(state.nextAttemptAt, 1000);

    await world.queue.advance(999); // 退避边界：未到期不投递
    equal(world.queue.getStatus("n1")!.attempts, 1);

    await world.queue.advance(1000); // 第2次失败，落地于 1000 → 下次 3000
    equal(world.queue.getStatus("n1")!.nextAttemptAt, 3000);
    await world.queue.advance(2999);
    equal(world.queue.getStatus("n1")!.attempts, 2);

    await world.queue.advance(3000); // 第3次失败 → 下次 7000
    equal(world.queue.getStatus("n1")!.nextAttemptAt, 7000);
    await world.queue.advance(7000); // 第4次失败 → 下次 15000
    equal(world.queue.getStatus("n1")!.nextAttemptAt, 15000);

    closeWorld(world); // 退避中途再次重启，不改变计时
    world = openWorld(dir, () => false);
    equal(world.queue.getStatus("n1")!.nextAttemptAt, 15000);
    await world.queue.advance(14999);
    equal(world.queue.getStatus("n1")!.attempts, 4);

    await world.queue.advance(15000); // 第5次失败 → failed
    state = world.queue.getStatus("n1")!;
    equal(state.status, "failed");
    equal(state.attempts, 5);
    equal(state.nextAttemptAt, null);

    await world.queue.advance(100000); // 终态后不再投递
    equal(world.receiver.getResult("n1", 6), null);
    equal(world.receiver.messageCount(), 0);

    world.queue.enqueue("n1", "other", 200000); // 重复入队不能重启终态
    await world.queue.advance(200000);
    equal(world.queue.getStatus("n1")!.status, "failed");
    equal(world.receiver.getResult("n1", 6), null);
    closeWorld(world);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("阅读确认先于投递返回到达，完成投递及重启后状态仍为 read", async () => {
  const dir = makeDir();
  try {
    let world = openWorld(dir, () => true);
    world.queue.enqueue("n1", "body", 10);
    // 接收方已实际收到消息，但队列尚未获知投递成功
    await world.receiver.deliver("n1", 1, "body", 10);
    world.queue.ackRead("n1"); // 阅读确认先到达
    equal(world.queue.getStatus("n1")!.status, "read");

    await world.queue.advance(10); // 完成投递确认，状态不得降级
    equal(world.queue.getStatus("n1")!.status, "read");
    world.queue.ackRead("n1"); // 重复确认无副作用
    equal(world.queue.getStatus("n1")!.status, "read");
    closeWorld(world);

    world = openWorld(dir, () => true); // 再次重启恢复
    await world.queue.advance(20);
    equal(world.queue.getStatus("n1")!.status, "read");
    equal(world.receiver.messageCount(), 1);
    equal(world.receiver.getMessage("n1"), "body");
    closeWorld(world);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("重复入队不重置尝试次数、退避时间、消息与已完成状态", async () => {
  const dir = makeDir();
  try {
    const world = openWorld(dir, (_id, attempt) => attempt >= 2);
    world.queue.enqueue("n1", "first", 0);
    await world.queue.advance(0); // 第1次失败 → 下次 1000
    world.queue.enqueue("n1", "second", 500); // 重复入队被忽略
    let state = world.queue.getStatus("n1")!;
    equal(state.attempts, 1);
    equal(state.nextAttemptAt, 1000);

    await world.queue.advance(1000); // 第2次成功，投递的仍是首条消息
    state = world.queue.getStatus("n1")!;
    equal(state.status, "delivered");
    equal(world.receiver.getMessage("n1"), "first");

    world.queue.enqueue("n1", "third", 2000); // 终态后重复入队无效
    await world.queue.advance(2000);
    equal(world.queue.getStatus("n1")!.status, "delivered");
    equal(world.receiver.getMessage("n1"), "first");
    equal(world.receiver.getResult("n1", 3), null);
    closeWorld(world);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("首次投递可立即进行，未知通知返回 null", async () => {
  const dir = makeDir();
  try {
    const world = openWorld(dir, () => true);
    equal(world.queue.getStatus("missing"), null);
    world.queue.enqueue("n1", "hi", 42);
    deepEqual(world.queue.getStatus("n1"), {
      id: "n1",
      status: "queued",
      attempts: 0,
      nextAttemptAt: 42,
    });
    await world.queue.advance(42); // 到期即可投递，无需等待
    equal(world.queue.getStatus("n1")!.status, "delivered");
    equal(world.receiver.getMessage("n1"), "hi");
    closeWorld(world);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
