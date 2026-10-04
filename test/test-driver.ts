import { Driver, Peer } from "../src/types";

interface PendingInstall {
  peer: Peer;
  resolve: () => void;
  reject: (err: Error) => void;
}

interface PendingRemove {
  tunnelId: string;
  resolve: () => void;
  reject: (err: Error) => void;
}

export class TestDriver implements Driver {
  readonly peers = new Map<string, Peer>();
  readonly installCalls: Peer[] = [];
  readonly removeCalls: string[] = [];
  private readonly pendingInstalls: PendingInstall[] = [];
  private readonly pendingRemoves: PendingRemove[] = [];

  install(peer: Peer): Promise<void> {
    this.installCalls.push(peer);
    return new Promise<void>((resolve, reject) => {
      this.pendingInstalls.push({ peer, resolve, reject });
    });
  }

  remove(tunnelId: string): Promise<void> {
    this.removeCalls.push(tunnelId);
    return new Promise<void>((resolve, reject) => {
      this.pendingRemoves.push({ tunnelId, resolve, reject });
    });
  }

  get pendingInstallCount(): number {
    return this.pendingInstalls.length;
  }

  get pendingRemoveCount(): number {
    return this.pendingRemoves.length;
  }

  completeNextInstall(): void {
    const pending = this.pendingInstalls.shift();
    if (!pending) {
      throw new Error("no pending install");
    }
    this.peers.set(pending.peer.tunnelId, pending.peer);
    pending.resolve();
  }

  failNextInstall(err: Error = new Error("install failed")): void {
    const pending = this.pendingInstalls.shift();
    if (!pending) {
      throw new Error("no pending install");
    }
    pending.reject(err);
  }

  completeNextRemove(): void {
    const pending = this.pendingRemoves.shift();
    if (!pending) {
      throw new Error("no pending remove");
    }
    this.peers.delete(pending.tunnelId);
    pending.resolve();
  }

  failNextRemove(err: Error = new Error("remove failed")): void {
    const pending = this.pendingRemoves.shift();
    if (!pending) {
      throw new Error("no pending remove");
    }
    pending.reject(err);
  }
}
