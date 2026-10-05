/** 一个“环境、资源类型、动作”三元组。 */
export interface Triple {
  readonly environment: string;
  readonly resourceType: string;
  readonly action: string;
}

/** 一项授权：唯一正整数编号 + 最终有效覆盖范围。 */
export interface Grant {
  readonly id: number;
  readonly coverage: readonly Triple[];
}

/** 一条访问日志。 */
export interface AccessEvent {
  readonly triple: Triple;
  /** 事件发生时刻，epoch 毫秒。 */
  readonly timestamp: number;
  readonly success: boolean;
}

/** 调用方提供的分析快照（对应一个用户）。 */
export interface Snapshot {
  /** 分析基准时刻 T，epoch 毫秒。 */
  readonly now: number;
  readonly grants: readonly Grant[];
  readonly events: readonly AccessEvent[];
}

/** 建议结果：保留与撤销清单。 */
export interface Advice {
  /** 保留授权编号，按数值升序。 */
  readonly keep: readonly number[];
  /** 撤销授权编号，按数值升序。 */
  readonly revoke: readonly number[];
}
