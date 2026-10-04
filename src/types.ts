/** 部署尝试结果。 */
export type Outcome = "Installed" | "Failed";

/** 流标识：deviceId + applicationId 共同唯一标识一条流。 */
export interface StreamKey {
  deviceId: string;
  applicationId: string;
}

/** 一条结果上报。 */
export interface Report extends StreamKey {
  /** 派发顺序号，正整数。 */
  seq: number;
  /** 版本号，同一 seq 以最高 revision 为准。 */
  revision: number;
  outcome: Outcome;
}

/** 告警区间，闭区间 [start, end]，长度 end - start + 1 >= 6。 */
export interface AlertInterval {
  start: number;
  end: number;
}

/** apply 的返回：本次调用新增与移除的告警区间。 */
export interface AlertDiff {
  added: AlertInterval[];
  removed: AlertInterval[];
}
