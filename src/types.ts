export type Outcome = "Installed" | "Failed";

export interface StreamKey {
  deviceId: string;
  applicationId: string;
}

export interface Report extends StreamKey {
  seq: number;
  revision: number;
  outcome: Outcome;
}

/** 闭区间 [start, end]，端点为 seq。 */
export interface AlertInterval {
  start: number;
  end: number;
}

export interface ApplyResult {
  added: AlertInterval[];
  removed: AlertInterval[];
}
