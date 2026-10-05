/** 业务时刻：Unix 毫秒时间戳（精确到毫秒）。 */
export type BusinessInstant = number;

/** 减损申请（loss mitigation application）某一修订版本的业务事实。 */
export interface ApplicationFacts {
  /** 资料齐全时刻（完整申请成立的时刻）。 */
  readonly completeAt: BusinessInstant;
  /** 终止时刻（永久修改 / 拒绝 / 撤回）；null 表示仍在待处理。 */
  readonly terminatedAt: BusinessInstant | null;
}

/** 止赎推进（foreclosure advancement）某一修订版本的业务事实。 */
export interface AdvancementFacts {
  readonly occurredAt: BusinessInstant;
}

/** 登记/更正命令：携带稳定编号、修订号与业务事实。 */
export interface UpsertApplicationCommand {
  readonly kind: "upsert-application";
  readonly applicationId: string;
  readonly revision: number;
  readonly loanId: string;
  readonly facts: ApplicationFacts;
}

export interface VoidApplicationCommand {
  readonly kind: "void-application";
  readonly applicationId: string;
  readonly revision: number;
}

export interface UpsertAdvancementCommand {
  readonly kind: "upsert-advancement";
  readonly advancementId: string;
  readonly revision: number;
  readonly loanId: string;
  readonly facts: AdvancementFacts;
}

export interface VoidAdvancementCommand {
  readonly kind: "void-advancement";
  readonly advancementId: string;
  readonly revision: number;
}

export type Command =
  | UpsertApplicationCommand
  | VoidApplicationCommand
  | UpsertAdvancementCommand
  | VoidAdvancementCommand;

/** 单条推进的判定结果。 */
export interface Determination {
  readonly advancementId: string;
  /** 推进是否仍有效（未被作废）。 */
  readonly active: boolean;
  /** 是否违反双轨保护（推进时刻落在至少一份同贷款申请的保护区间内）。 */
  readonly violation: boolean;
  /** 提供保护的申请编号列表（当前有效版本）。 */
  readonly protectingApplicationIds: readonly string[];
}
