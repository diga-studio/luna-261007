/**
 * 领域类型定义。
 * 业务时刻统一使用 epoch 毫秒（number）。
 */

/** 减损申请的一个版本（登记 / 更正 / 作废共用一个结构）。 */
export interface ApplicationRevision {
  /** 稳定编号 */
  id: string;
  /** 所属贷款，固定不变 */
  loanId: string;
  /** 修订号，单调递增；同一编号只采用最高修订号 */
  revision: number;
  /** 资料齐全时刻（epoch ms），保护区间起点（含） */
  completeAt: number;
  /** 终止时刻（epoch ms），保护区间终点（不含）；null 表示仍在待处理 */
  terminatedAt: number | null;
  /** 是否为作废记录（墓碑，同样占用修订号） */
  voided: boolean;
}

/** 止赎推进的一个版本。 */
export interface AdvancementRevision {
  /** 稳定编号 */
  id: string;
  /** 所属贷款，固定不变 */
  loanId: string;
  /** 修订号 */
  revision: number;
  /** 推进发生的业务时刻（epoch ms） */
  occurredAt: number;
  /** 是否为作废记录 */
  voided: boolean;
}

/** 单条推进的核查结论。 */
export interface AdvancementVerdict {
  /** 推进编号 */
  advancementId: string;
  /** 推进是否存在（当前有效版本未作废） */
  active: boolean;
  /** 是否违规：推进时刻落在至少一份同贷款申请的保护区间内 */
  violation: boolean;
  /** 提供保护的申请编号列表（按编号排序） */
  protectedBy: string[];
}
