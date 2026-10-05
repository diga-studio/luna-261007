import type { ApplicationRevision, AdvancementRevision, AdvancementVerdict } from "./types.js";

/**
 * 判定时刻 at 是否落在申请保护区间 [completeAt, terminatedAt) 内。
 * 包含资料齐全时刻，不包含终止时刻；terminatedAt 为 null 表示仍在待处理。
 */
export function isProtectedAt(app: ApplicationRevision, at: number): boolean {
  if (app.voided) return false;
  if (at < app.completeAt) return false;
  if (app.terminatedAt !== null && at >= app.terminatedAt) return false;
  return true;
}

/**
 * 基于当前有效记录，独立核算一条推进的结论。
 * advancement 为 null 表示该编号从未登记。
 */
export function evaluate(
  advancement: AdvancementRevision | null,
  applications: ApplicationRevision[],
): AdvancementVerdict {
  if (advancement === null) {
    return { advancementId: "", active: false, violation: false, protectedBy: [] };
  }
  if (advancement.voided) {
    return { advancementId: advancement.id, active: false, violation: false, protectedBy: [] };
  }
  const protectedBy = applications
    .filter((app) => app.loanId === advancement.loanId && isProtectedAt(app, advancement.occurredAt))
    .map((app) => app.id)
    .sort();
  return {
    advancementId: advancement.id,
    active: true,
    violation: protectedBy.length > 0,
    protectedBy,
  };
}
