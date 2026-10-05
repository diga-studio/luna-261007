/** 可控故障注入点：模拟进程在关键持久化步骤之间被杀。 */
export type CrashPoint =
  /** begin 已持久化生效、但响应尚未返回。 */
  | 'begin:afterPersist'
  /** 答卷与提交时间已被持久接纳、但证书尚未落盘。 */
  | 'submit:afterSubmissionPersisted'
  /** 证书已落盘、但 submit 尚未返回。 */
  | 'submit:afterCertWritten';

export class SimulatedCrash extends Error {
  constructor(public readonly point: CrashPoint) {
    super(`simulated process crash at ${point}`);
    this.name = 'SimulatedCrash';
  }
}

/**
 * 故障注入器。arm(point) 后，下一次到达该点即抛出 SimulatedCrash，
 * 模拟进程终止；之后调用方应丢弃当前服务实例并重开数据目录。
 */
export class FaultInjector {
  private readonly armed = new Set<CrashPoint>();

  arm(point: CrashPoint): void {
    this.armed.add(point);
  }

  clear(): void {
    this.armed.clear();
  }

  /** 内部使用：到达故障点。 */
  hit(point: CrashPoint): void {
    if (this.armed.delete(point)) {
      throw new SimulatedCrash(point);
    }
  }
}

/** 不注入任何故障的默认注入器。 */
export const NO_FAULTS = new FaultInjector();
