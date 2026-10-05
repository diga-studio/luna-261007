import { Store } from "./store.js";
import { evaluate } from "./engine.js";
import type { ApplicationRevision, AdvancementRevision, AdvancementVerdict } from "./types.js";

export * from "./types.js";
export { isProtectedAt, evaluate } from "./engine.js";

/**
 * 双轨保护核查库入口，由上层业务系统直接调用。
 *
 * 判定始终基于当前掌握的最高修订号记录独立核算，
 * 与记录进入系统的先后顺序无关。
 */
export class DualTrackReview {
  private readonly store: Store;

  /** dbPath 传 ":memory:" 可纯内存运行 */
  constructor(dbPath: string) {
    this.store = new Store(dbPath);
  }

  close(): void {
    this.store.close();
  }

  /** 批量登记 / 更正 / 作废减损申请；只采用每个编号的最高修订号 */
  submitApplications(batch: ApplicationRevision[]): void {
    this.store.upsertApplications(batch);
  }

  /** 批量登记 / 更正 / 作废止赎推进；只采用每个编号的最高修订号 */
  submitAdvancements(batch: AdvancementRevision[]): void {
    this.store.upsertAdvancements(batch);
  }

  /** 查询任意一条推进的当前判定 */
  checkAdvancement(id: string): AdvancementVerdict {
    const advancement = this.store.getAdvancement(id);
    if (advancement === null) {
      return { advancementId: id, active: false, violation: false, protectedBy: [] };
    }
    const applications = advancement.voided
      ? []
      : this.store.listActiveApplicationsByLoan(advancement.loanId);
    return evaluate(advancement, applications);
  }
}
