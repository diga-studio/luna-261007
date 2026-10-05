import type { EffectiveAdvancement, EffectiveApplication } from "./store.js";
import type { Determination } from "./types.js";

/**
 * 判定推进时刻是否被申请保护。
 * 保护区间为 [completeAt, terminatedAt)：包含资料齐全时刻，不包含终止时刻；
 * 终止时刻为空表示仍在待处理，保护无限延伸。
 */
export function isProtectedAt(
  application: EffectiveApplication,
  instant: number,
): boolean {
  if (application.voided || application.completeAt === null) return false;
  if (instant < application.completeAt) return false;
  if (application.terminatedAt !== null && instant >= application.terminatedAt) {
    return false;
  }
  return true;
}

/** 依据当前有效记录，独立核算单条推进的判定。 */
export function determine(
  advancement: EffectiveAdvancement,
  applications: readonly EffectiveApplication[],
): Determination {
  if (advancement.voided || advancement.occurredAt === null) {
    return {
      advancementId: advancement.advancementId,
      active: false,
      violation: false,
      protectingApplicationIds: [],
    };
  }
  const protecting = applications
    .filter(
      (application) =>
        application.loanId === advancement.loanId &&
        isProtectedAt(application, advancement.occurredAt!),
    )
    .map((application) => application.applicationId)
    .sort();
  return {
    advancementId: advancement.advancementId,
    active: true,
    violation: protecting.length > 0,
    protectingApplicationIds: protecting,
  };
}
