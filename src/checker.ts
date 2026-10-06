import { earliestConflict } from "./conflict";
import { formatDate } from "./date";
import { compileSchedule, type CompiledSchedule } from "./schedule";
import { formatUtcInstant } from "./timezone";
import type { CheckResult, ScheduleInput } from "./types";

/**
 * 团购周期排期检查器。数据仅保存在进程内。
 * 装入已发布排期集合后，可逐条检查待发布排期；检查不改变已发布数据。
 */
export class ScheduleChecker {
  private readonly byPickupPoint = new Map<string, CompiledSchedule[]>();
  private count = 0;

  /** 已装入的已发布排期数量。 */
  get size(): number {
    return this.count;
  }

  /** 装入一批已发布排期（可多次调用，效果为追加）。 */
  loadPublished(schedules: ScheduleInput[]): void {
    for (const input of schedules) {
      const compiled = compileSchedule(input);
      let list = this.byPickupPoint.get(compiled.pickupPointId);
      if (!list) {
        list = [];
        this.byPickupPoint.set(compiled.pickupPointId, list);
      }
      list.push(compiled);
      this.count++;
    }
  }

  /** 检查一条待发布排期能否发布。 */
  check(candidate: ScheduleInput): CheckResult {
    const compiled = compileSchedule(candidate);
    const existing = this.byPickupPoint.get(compiled.pickupPointId);
    if (!existing || existing.length === 0) return { ok: true };
    let bestInstant = Infinity;
    let bestExisting: CompiledSchedule | null = null;
    let bestSharedSku = "";
    let bestCandidateOpenDay = 0;
    let bestExistingOpenDay = 0;
    for (const other of existing) {
      let sharedSku: string | null = null;
      for (const sku of compiled.skuIds) {
        if (other.skuSet.has(sku)) {
          sharedSku = sku;
          break;
        }
      }
      if (sharedSku === null) continue;
      const conflict = earliestConflict(compiled, other);
      if (conflict && conflict.instantUtc < bestInstant) {
        bestInstant = conflict.instantUtc;
        bestExisting = other;
        bestSharedSku = sharedSku;
        bestCandidateOpenDay = conflict.openDayA;
        bestExistingOpenDay = conflict.openDayB;
      }
    }
    if (!bestExisting) return { ok: true };
    return {
      ok: false,
      earliestInstantUtc: formatUtcInstant(bestInstant),
      existingScheduleId: bestExisting.id,
      sharedSku: bestSharedSku,
      candidateOpenDate: formatDate(bestCandidateOpenDay),
      existingOpenDate: formatDate(bestExistingOpenDay),
    };
  }
}
