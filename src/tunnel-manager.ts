import type { ApprovedDevice, Driver, OpenResult, Peer } from "./types.js";

const MAX_TUNNELS_PER_USER = 3;

type TunnelState = "installing" | "active" | "closing" | "close-failed";

interface DeviceEntry {
  readonly deviceId: string;
  readonly userId: string;
  blocked: boolean;
}

interface TunnelRecord {
  readonly tunnelId: string;
  readonly deviceId: string;
  readonly userId: string;
  readonly ip: string;
  state: TunnelState;
  installSucceeded: boolean;
  installBarrier: Promise<void>;
  markInstallSettled: () => void;
  teardown: Promise<void> | null;
  settleOpen: (result: OpenResult) => void;
  failOpen: (reason: unknown) => void;
}

export class TunnelManager {
  private readonly freeAddresses: string[];
  private readonly devices = new Map<string, DeviceEntry>();
  private readonly tunnels = new Map<string, TunnelRecord>();
  private readonly driver: Driver;
  private nextTunnelSeq = 0;

  constructor(
    addresses: readonly string[],
    devices: readonly ApprovedDevice[],
    driver: Driver,
  ) {
    if (new Set(addresses).size !== addresses.length) {
      throw new Error("addresses must be distinct");
    }
    this.freeAddresses = [...addresses];
    for (const device of devices) {
      if (this.devices.has(device.deviceId)) {
        throw new Error(`duplicate device: ${device.deviceId}`);
      }
      this.devices.set(device.deviceId, {
        deviceId: device.deviceId,
        userId: device.userId,
        blocked: false,
      });
    }
    this.driver = driver;
  }

  open(deviceId: string): Promise<OpenResult> {
    const device = this.devices.get(deviceId);
    if (!device) {
      return Promise.reject(new Error(`unknown device: ${deviceId}`));
    }
    if (device.blocked) {
      return Promise.reject(new Error(`device is blocked: ${deviceId}`));
    }
    let userTunnelCount = 0;
    for (const record of this.tunnels.values()) {
      if (record.userId === device.userId) {
        userTunnelCount += 1;
      }
    }
    if (userTunnelCount >= MAX_TUNNELS_PER_USER) {
      return Promise.reject(
        new Error(`user ${device.userId} exceeds ${MAX_TUNNELS_PER_USER} tunnels`),
      );
    }
    const ip = this.freeAddresses.pop();
    if (ip === undefined) {
      return Promise.reject(new Error("no address available"));
    }

    this.nextTunnelSeq += 1;
    const tunnelId = `tunnel-${this.nextTunnelSeq}`;
    let settleOpen!: (result: OpenResult) => void;
    let failOpen!: (reason: unknown) => void;
    const opened = new Promise<OpenResult>((resolve, reject) => {
      settleOpen = resolve;
      failOpen = reject;
    });
    let markInstallSettled!: () => void;
    const installBarrier = new Promise<void>((resolve) => {
      markInstallSettled = resolve;
    });
    const record: TunnelRecord = {
      tunnelId,
      deviceId,
      userId: device.userId,
      ip,
      state: "installing",
      installSucceeded: false,
      installBarrier,
      markInstallSettled,
      teardown: null,
      settleOpen,
      failOpen,
    };
    this.tunnels.set(tunnelId, record);

    const peer: Peer = { tunnelId, deviceId, ip };
    let installPromise: Promise<void>;
    try {
      installPromise = this.driver.install(peer);
    } catch (error) {
      installPromise = Promise.reject(error);
    }
    installPromise.then(
      () => this.onInstallSettled(record, true, undefined),
      (error) => this.onInstallSettled(record, false, error),
    );
    return opened;
  }

  close(tunnelId: string): Promise<void> {
    const record = this.tunnels.get(tunnelId);
    if (!record) {
      return Promise.resolve();
    }
    return this.requestTeardown(record);
  }

  async block(deviceId: string): Promise<void> {
    const device = this.devices.get(deviceId);
    if (!device) {
      throw new Error(`unknown device: ${deviceId}`);
    }
    device.blocked = true;
    const pending: Promise<void>[] = [];
    for (const record of this.tunnels.values()) {
      if (record.deviceId === deviceId) {
        pending.push(this.requestTeardown(record));
      }
    }
    await Promise.all(pending);
  }

  private onInstallSettled(
    record: TunnelRecord,
    succeeded: boolean,
    error: unknown,
  ): void {
    record.installSucceeded = succeeded;
    record.markInstallSettled();
    if (record.state === "installing") {
      if (succeeded) {
        record.state = "active";
        record.settleOpen({ tunnelId: record.tunnelId, ip: record.ip });
      } else {
        record.state = "closing";
        record.failOpen(error ?? new Error("install failed"));
        this.finishTeardown(record);
      }
      return;
    }
    if (!succeeded) {
      record.failOpen(error ?? new Error("install failed"));
    }
  }

  private requestTeardown(record: TunnelRecord): Promise<void> {
    if (record.state === "installing" || record.state === "active") {
      record.state = "closing";
      record.failOpen(new Error(`tunnel ${record.tunnelId} was closed`));
    }
    if (record.teardown) {
      return record.teardown;
    }
    const teardown = this.runTeardown(record);
    record.teardown = teardown;
    return teardown;
  }

  private async runTeardown(record: TunnelRecord): Promise<void> {
    await record.installBarrier;
    if (record.installSucceeded) {
      try {
        await this.driver.remove(record.tunnelId);
      } catch (error) {
        record.state = "close-failed";
        record.teardown = null;
        throw error;
      }
    }
    this.finishTeardown(record);
  }

  private finishTeardown(record: TunnelRecord): void {
    this.freeAddresses.push(record.ip);
    this.tunnels.delete(record.tunnelId);
  }
}
