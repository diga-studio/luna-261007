import { DeviceInfo, Driver, OpenResult, Peer } from "./types";

const MAX_TUNNELS_PER_USER = 3;

type Phase = "installing" | "active" | "closing";
type InstallOutcome = "installed" | "failed";

interface TunnelRecord {
  readonly tunnelId: string;
  readonly deviceId: string;
  readonly userId: string;
  readonly ip: string;
  phase: Phase;
  installDone: Promise<void>;
  installOutcome: InstallOutcome | null;
  removeInFlight: Promise<void> | null;
  released: boolean;
}

export class TunnelManager {
  private readonly driver: Driver;
  private readonly devices = new Map<string, DeviceInfo>();
  private readonly freeIps: string[];
  private readonly records = new Map<string, TunnelRecord>();
  private readonly userSlotCounts = new Map<string, number>();
  private readonly blocked = new Set<string>();
  private nextTunnelSeq = 0;

  constructor(
    addresses: readonly string[],
    devices: readonly DeviceInfo[],
    driver: Driver,
  ) {
    this.freeIps = [...addresses];
    for (const device of devices) {
      this.devices.set(device.deviceId, device);
    }
    this.driver = driver;
  }

  async open(deviceId: string): Promise<OpenResult> {
    const device = this.devices.get(deviceId);
    if (!device) {
      throw new Error(`unknown device: ${deviceId}`);
    }
    if (this.blocked.has(deviceId)) {
      throw new Error(`device is blocked: ${deviceId}`);
    }
    const usedSlots = this.userSlotCounts.get(device.userId) ?? 0;
    if (usedSlots >= MAX_TUNNELS_PER_USER) {
      throw new Error(`user ${device.userId} has no free tunnel slot`);
    }
    const ip = this.freeIps.shift();
    if (ip === undefined) {
      throw new Error("no free address");
    }

    const record: TunnelRecord = {
      tunnelId: `tunnel-${++this.nextTunnelSeq}`,
      deviceId,
      userId: device.userId,
      ip,
      phase: "installing",
      installDone: Promise.resolve(),
      installOutcome: null,
      removeInFlight: null,
      released: false,
    };
    this.records.set(record.tunnelId, record);
    this.userSlotCounts.set(device.userId, usedSlots + 1);

    const peer: Peer = {
      tunnelId: record.tunnelId,
      deviceId,
      ip,
    };
    record.installDone = this.driver.install(peer).then(
      () => this.settleInstall(record, "installed"),
      () => this.settleInstall(record, "failed"),
    );
    await record.installDone;

    if (record.installOutcome === "failed") {
      throw new Error(`install failed for device: ${deviceId}`);
    }
    if (record.phase === "closing") {
      throw new Error(`tunnel ${record.tunnelId} was closed during install`);
    }
    return { tunnelId: record.tunnelId, ip: record.ip };
  }

  async close(tunnelId: string): Promise<void> {
    const record = this.records.get(tunnelId);
    if (!record) {
      return;
    }
    record.phase = "closing";
    await this.attemptRemove(record);
  }

  async block(deviceId: string): Promise<void> {
    if (!this.devices.has(deviceId)) {
      throw new Error(`unknown device: ${deviceId}`);
    }
    this.blocked.add(deviceId);
    const owned = [...this.records.values()].filter(
      (record) => record.deviceId === deviceId,
    );
    for (const record of owned) {
      record.phase = "closing";
    }
    await Promise.all(owned.map((record) => this.attemptRemove(record)));
  }

  private settleInstall(record: TunnelRecord, outcome: InstallOutcome): void {
    record.installOutcome = outcome;
    if (outcome === "installed" && record.phase === "installing") {
      record.phase = "active";
    }
    if (outcome === "failed" && record.phase !== "closing") {
      this.release(record);
    }
  }

  private attemptRemove(record: TunnelRecord): Promise<void> {
    if (record.removeInFlight) {
      return record.removeInFlight;
    }
    record.removeInFlight = (async () => {
      try {
        await record.installDone;
        if (record.installOutcome === "installed") {
          await this.driver.remove(record.tunnelId);
        }
        this.release(record);
      } finally {
        record.removeInFlight = null;
      }
    })();
    return record.removeInFlight;
  }

  private release(record: TunnelRecord): void {
    if (record.released) {
      return;
    }
    record.released = true;
    this.records.delete(record.tunnelId);
    this.freeIps.push(record.ip);
    this.userSlotCounts.set(
      record.userId,
      (this.userSlotCounts.get(record.userId) ?? 1) - 1,
    );
  }
}
