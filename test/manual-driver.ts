import type { Driver, Peer } from "../src/types.js";

export interface PendingCall<A> {
  readonly arg: A;
  accept(): void;
  fail(reason?: unknown): void;
}

export class ManualDriver implements Driver {
  private readonly installed = new Map<string, Peer>();
  private readonly pendingInstalls: PendingCall<Peer>[] = [];
  private readonly pendingRemoves: PendingCall<string>[] = [];

  install(peer: Peer): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.pendingInstalls.push({
        arg: peer,
        accept: () => {
          this.installed.set(peer.tunnelId, peer);
          resolve();
        },
        fail: (reason) => {
          reject(reason ?? new Error(`install failed: ${peer.tunnelId}`));
        },
      });
    });
  }

  remove(tunnelId: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.pendingRemoves.push({
        arg: tunnelId,
        accept: () => {
          this.installed.delete(tunnelId);
          resolve();
        },
        fail: (reason) => {
          reject(reason ?? new Error(`remove failed: ${tunnelId}`));
        },
      });
    });
  }

  peers(): ReadonlyMap<string, Peer> {
    return this.installed;
  }

  installs(): readonly PendingCall<Peer>[] {
    return this.pendingInstalls;
  }

  removes(): readonly PendingCall<string>[] {
    return this.pendingRemoves;
  }
}
