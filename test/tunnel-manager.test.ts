import { test } from "node:test";
import * as assert from "node:assert/strict";
import { TunnelManager } from "../src/tunnel-manager";
import { TestDriver } from "./test-driver";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("paused install then block: address held until cleanup succeeds, blocked device never reinstalls", async () => {
  const driver = new TestDriver();
  const manager = new TunnelManager(
    ["10.0.0.1"],
    [
      { deviceId: "d1", userId: "u1" },
      { deviceId: "d2", userId: "u2" },
    ],
    driver,
  );

  const openP = manager.open("d1");
  const openFailedP = assert.rejects(openP);
  assert.equal(driver.pendingInstallCount, 1);

  const blockP = manager.block("d1");
  await tick();
  assert.equal(driver.pendingRemoveCount, 0);

  await assert.rejects(manager.open("d2"));

  driver.completeNextInstall();
  await tick();
  assert.equal(driver.pendingRemoveCount, 1);
  assert.equal(driver.peers.size, 1);

  driver.failNextRemove();
  await assert.rejects(blockP);
  await openFailedP;
  assert.equal(driver.peers.size, 1);

  await assert.rejects(manager.open("d2"));

  const installCallsBefore = driver.installCalls.length;
  await assert.rejects(manager.open("d1"));
  assert.equal(driver.installCalls.length, installCallsBefore);

  const retryBlockP = manager.block("d1");
  await tick();
  assert.equal(driver.pendingRemoveCount, 1);
  driver.completeNextRemove();
  await retryBlockP;
  assert.equal(driver.peers.size, 0);

  const open2P = manager.open("d2");
  await tick();
  assert.equal(driver.pendingInstallCount, 1);
  driver.completeNextInstall();
  const opened = await open2P;
  assert.equal(opened.ip, "10.0.0.1");
});

test("user limited to 3 tunnel slots; close is idempotent; released slot and address reusable", async () => {
  const driver = new TestDriver();
  const manager = new TunnelManager(
    ["10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4"],
    [
      { deviceId: "d1", userId: "u1" },
      { deviceId: "d2", userId: "u1" },
      { deviceId: "d3", userId: "u1" },
      { deviceId: "d4", userId: "u1" },
    ],
    driver,
  );

  const opens = ["d1", "d2", "d3"].map(async (deviceId) => {
    const pending = manager.open(deviceId);
    await tick();
    driver.completeNextInstall();
    return pending;
  });
  const established = await Promise.all(opens);
  assert.equal(driver.peers.size, 3);

  await assert.rejects(manager.open("d4"));
  assert.equal(driver.pendingInstallCount, 0);

  const closeP = manager.close(established[0].tunnelId);
  await tick();
  assert.equal(driver.pendingRemoveCount, 1);
  driver.completeNextRemove();
  await closeP;
  assert.equal(driver.peers.size, 2);

  await manager.close(established[0].tunnelId);
  await manager.close("tunnel-never-existed");

  const reopenP = manager.open("d4");
  await tick();
  assert.equal(driver.pendingInstallCount, 1);
  driver.completeNextInstall();
  const reopened = await reopenP;
  assert.ok(reopened.ip.length > 0);
  assert.equal(driver.peers.size, 3);
});

test("failed install releases reserved address and user slot", async () => {
  const driver = new TestDriver();
  const manager = new TunnelManager(
    ["10.0.0.1", "10.0.0.2", "10.0.0.3"],
    [
      { deviceId: "d1", userId: "u1" },
      { deviceId: "d2", userId: "u1" },
      { deviceId: "d3", userId: "u1" },
    ],
    driver,
  );

  for (const deviceId of ["d1", "d2"]) {
    const pending = manager.open(deviceId);
    await tick();
    driver.completeNextInstall();
    await pending;
  }
  assert.equal(driver.peers.size, 2);

  const failingOpenP = manager.open("d3");
  await tick();
  assert.equal(driver.pendingInstallCount, 1);
  driver.failNextInstall();
  await assert.rejects(failingOpenP);
  assert.equal(driver.peers.size, 2);

  const retryP = manager.open("d3");
  await tick();
  assert.equal(driver.pendingInstallCount, 1);
  driver.completeNextInstall();
  const opened = await retryP;
  assert.equal(opened.ip, "10.0.0.3");
  assert.equal(driver.peers.size, 3);
});
