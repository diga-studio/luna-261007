import { determine } from "./engine.js";
import { Store } from "./store.js";
import type { Command, Determination } from "./types.js";

export * from "./types.js";
export { Store } from "./store.js";
export { determine, isProtectedAt } from "./engine.js";

/**
 * 双轨保护核查库入口，由上层业务系统直接调用。
 * 判定始终依据当前掌握的最高修订号业务事实，与记录进入系统的先后顺序无关。
 */
export class DualTrackReview {
  private readonly store: Store;

  /** @param dbPath SQLite 文件路径；传 ":memory:" 使用内存库。 */
  constructor(dbPath: string) {
    this.store = new Store(dbPath);
  }

  /** 批量登记、更正或作废；同一批命令在一个事务中生效。 */
  submit(commands: readonly Command[]): void {
    this.store.applyBatch(commands);
  }

  /** 查询任意一条推进的当前判定；编号不存在时返回 null。 */
  determineAdvancement(advancementId: string): Determination | null {
    const advancement = this.store.getAdvancement(advancementId);
    if (!advancement) return null;
    const applications = this.store.listEffectiveApplications(advancement.loanId);
    return determine(advancement, applications);
  }

  /** 查询一笔贷款当前全部有效推进的判定。 */
  determineLoan(loanId: string): Determination[] {
    const applications = this.store.listEffectiveApplications(loanId);
    return this.store
      .listEffectiveAdvancements(loanId)
      .map((advancement) => determine(advancement, applications));
  }

  close(): void {
    this.store.close();
  }
}
