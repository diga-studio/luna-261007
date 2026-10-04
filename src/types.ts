export interface Peer {
  readonly tunnelId: string;
  readonly deviceId: string;
  readonly ip: string;
}

export interface Driver {
  install(peer: Peer): Promise<void>;
  remove(tunnelId: string): Promise<void>;
}

export interface DeviceInfo {
  readonly deviceId: string;
  readonly userId: string;
}

export interface OpenResult {
  readonly tunnelId: string;
  readonly ip: string;
}
