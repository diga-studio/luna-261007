import assert from "node:assert/strict";
import { test } from "node:test";
import { TunnelManager } from "../src/tunnel-manager.js";
import type { OpenResult } from "../src/types.js";
import { ManualDriver } from "./manual-driver.js";

type Settled<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: unknown }
  | { status: "pending" };

function track<T>(promise: Promise<T>): { result: Settled<T> } {
  const box: { result: Settled<T> } = { result: { status: "pending" } };
  promise.then(
    (value) => {
      box.result = { status: "fulfilled", value };
    },
    (reason) => {
      box.result = { status: "rejected", reason };
    },
  );
  return box;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function expectReject(promise: Promise<unknown>): Promise<void> {
  await assert.rejects(promise);
}

test("paused install + block: address held until cleanup succeeds, then reusable", async () => {
  const driver = new ManualDriver();
  const manager = new TunnelManager(
    ["10.0.0.1"],
    [
      { deviceId: "d1", userId: "u1" },
      { deviceId: "d2", userId: "u2" },
    ],
    driver,
  );

  const openD1 = track(manager.open("d1"));
  await flush();
  assert.equal(driver.installs().length, 1);
  assert.equal(driver.installs()[0]!.arg.ip, "10.0.0.1");
  const tunnelId = driver.installs()[0]!.arg.tunnelId;

  const blocked = track(manager.block("d1"));
  await flush();
  assert.equal(blocked.result.status, "pending");

  await expectReject(manager.open("d1"));
  await flush();
  assert.equal(driver.installs().length, 1, "blocked device must not trigger install");

  await expectReject(manager.open("d2"));
  assert.equal(driver.installs().length, 1, "address still held by d1");

  driver.installs()[0]!.accept();
  await flush();
  assert.equal(openD1.result.status, "rejected", "original open must fail");
  assert.deepEqual(
    [...driver.peers().values()].map((p) => p.tunnelId),
    [tunnelId],
    "peer exists until removal completes",
  );
  assert.equal(driver.removes().length, 1);
  assert.equal(driver.removes()[0]!.arg, tunnelId);
  assert.equal(blocked.result.status, "pending");

  driver.removes()[0]!.fail();
  await flush();
  assert.equal(blocked.result.status, "rejected", "block reports cleanup failure");
  assert.ok(driver.peers().has(tunnelId), "peer survives failed removal");

  await expectReject(manager.open("d2"));
  assert.equal(driver.installs().length, 1, "address not reusable before cleanup");

  const retry = track(manager.block("d1"));
  await flush();
  assert.equal(driver.removes().length, 2, "retry issues another remove");
  driver.removes()[1]!.accept();
  await flush();
  assert.equal(retry.result.status, "fulfilled");
  assert.equal(driver.peers().size, 0, "peer gone after cleanup");

  const openD2 = track(manager.open("d2"));
  await flush();
  assert.equal(driver.installs().length, 2);
  assert.equal(driver.installs()[1]!.arg.ip, "10.0.0.1", "address reused after cleanup");
  assert.notEqual(driver.installs()[1]!.arg.tunnelId, tunnelId, "tunnelId never reused");
  driver.installs()[1]!.accept();
  await flush();
  assert.equal(openD2.result.status, "fulfilled");

  await expectReject(manager.open("d1"));
  assert.equal(driver.installs().length, 2, "blocked device stays blocked");
});

test("user quota is 3; failed install releases address and quota", async () => {
  const driver = new ManualDriver();
  const manager = new TunnelManager(
    ["10.0.0.1", "10.0.0.2", "10.0.0.3"],
    [
      { deviceId: "d1", userId: "u1" },
      { deviceId: "d2", userId: "u1" },
      { deviceId: "d3", userId: "u1" },
      { deviceId: "d4", userId: "u1" },
      { deviceId: "d5", userId: "u2" },
    ],
    driver,
  );

  const opens = [
    track(manager.open("d1")),
    track(manager.open("d2")),
    track(manager.open("d3")),
  ];
  await flush();
  assert.equal(driver.installs().length, 3);

  await expectReject(manager.open("d4"));
  assert.equal(driver.installs().length, 3, "4th tunnel of same user rejected");

  const other = track(manager.open("d5"));
  await flush();
  assert.equal(driver.installs().length, 3, "no address left for other user either");

  driver.installs()[0]!.fail();
  await flush();
  assert.equal(opens[0]!.result.status, "rejected");
  assert.equal(driver.peers().size, 0);

  const retry = track(manager.open("d4"));
  await flush();
  assert.equal(driver.installs().length, 4, "quota and address released after install failure");
  const reusedIp = driver.installs()[3]!.arg.ip;
  driver.installs()[1]!.accept();
  driver.installs()[2]!.accept();
  driver.installs()[3]!.accept();
  await flush();
  assert.equal(retry.result.status, "fulfilled");
  assert.equal(
    (retry.result as { value: OpenResult }).value.ip,
    reusedIp,
  );
  assert.equal(driver.peers().size, 3);

  await expectReject(manager.open("d1"));
  assert.equal(driver.installs().length, 4, "quota still full after 3 actives");
});

test("close removes active tunnel and releases its address", async () => {
  const driver = new ManualDriver();
  const manager = new TunnelManager(
    ["10.0.0.1"],
    [
      { deviceId: "d1", userId: "u1" },
      { deviceId: "d2", userId: "u2" },
    ],
    driver,
  );

  const opened = track(manager.open("d1"));
  await flush();
  driver.installs()[0]!.accept();
  await flush();
  assert.equal(opened.result.status, "fulfilled");
  const { tunnelId, ip } = (opened.result as { value: OpenResult }).value;
  assert.equal(ip, "10.0.0.1");

  const closed = track(manager.close(tunnelId));
  await flush();
  assert.equal(driver.removes().length, 1);
  driver.removes()[0]!.accept();
  await flush();
  assert.equal(closed.result.status, "fulfilled");
  assert.equal(driver.peers().size, 0);

  await manager.close(tunnelId);
  await manager.close("never-existed");

  const reopened = track(manager.open("d2"));
  await flush();
  assert.equal(driver.installs().length, 2);
  assert.equal(driver.installs()[1]!.arg.ip, "10.0.0.1");
  driver.installs()[1]!.accept();
  await flush();
  assert.equal(reopened.result.status, "fulfilled");
});

test("close failure keeps resources; retry continues cleanup", async () => {
  const driver = new ManualDriver();
  const manager = new TunnelManager(
    ["10.0.0.1"],
    [
      { deviceId: "d1", userId: "u1" },
      { deviceId: "d2", userId: "u2" },
    ],
    driver,
  );

  const opened = track(manager.open("d1"));
  await flush();
  driver.installs()[0]!.accept();
  await flush();
  const { tunnelId } = (opened.result as { value: OpenResult }).value;

  const firstClose = track(manager.close(tunnelId));
  await flush();
  driver.removes()[0]!.fail();
  await flush();
  assert.equal(firstClose.result.status, "rejected");
  assert.ok(driver.peers().has(tunnelId));

  await expectReject(manager.open("d2"));
  assert.equal(driver.installs().length, 1, "address still held after failed close");

  const secondClose = track(manager.close(tunnelId));
  await flush();
  assert.equal(driver.removes().length, 2, "retry issues another remove");
  driver.removes()[1]!.accept();
  await flush();
  assert.equal(secondClose.result.status, "fulfilled");
  assert.equal(driver.peers().size, 0);

  const reopened = track(manager.open("d2"));
  await flush();
  driver.installs()[1]!.accept();
  await flush();
  assert.equal(reopened.result.status, "fulfilled");
});

test("close during install revokes tunnel and fails the pending open", async () => {
  const driver = new ManualDriver();
  const manager = new TunnelManager(
    ["10.0.0.1"],
    [{ deviceId: "d1", userId: "u1" }],
    driver,
  );

  const opened = track(manager.open("d1"));
  await flush();
  const tunnelId = driver.installs()[0]!.arg.tunnelId;
  const closed = track(manager.close(tunnelId));
  await flush();
  assert.equal(closed.result.status, "pending");

  driver.installs()[0]!.accept();
  await flush();
  assert.equal(opened.result.status, "rejected", "open must fail once closed");
  assert.equal(driver.removes().length, 1, "installed peer must be removed");
  driver.removes()[0]!.accept();
  await flush();
  assert.equal(closed.result.status, "fulfilled");
  assert.equal(driver.peers().size, 0, "install must not resurrect the peer");
});

test("open rejects for unknown device", async () => {
  const driver = new ManualDriver();
  const manager = new TunnelManager(
    ["10.0.0.1"],
    [{ deviceId: "d1", userId: "u1" }],
    driver,
  );
  await expectReject(manager.open("nope"));
  assert.equal(driver.installs().length, 0);
});
