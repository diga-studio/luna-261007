/** 排期检查库入口：装入已发布排期集合，检查待发布排期。 */
import { earliestConflictBetween } from "./conflict.js";
import { parseSchedule, type ParsedSchedule } from "./parsed.js";
import { serialDayToDateString, utcMinutesToIsoString } from "./calendar.js";
import type { CheckResult, ScheduleInput } from "./types.js";

export class ScheduleStore {
  /** 取货点 -> 该取货点的已发布排期。 */
  private readonly byPickupPoint = new Map<string, ParsedSchedule[]>();
  private size = 0;

  constructor(schedules?: ScheduleInput[]) {
    if (schedules) this.load(schedules);
  }

  /** 装入（替换）已发布排期集合。 */
  load(schedules: ScheduleInput[]): void {
    this.byPickupPoint.clear();
    this.size = 0;
    for (const input of schedules) {
      const parsed = parseSchedule(input);
      let bucket = this.byPickupPoint.get(parsed.pickupPointId);
      if (!bucket) {
        bucket = [];
        this.byPickupPoint.set(parsed.pickupPointId, bucket);
      }
      bucket.push(parsed);
      this.size++;
    }
  }

  /** 已发布排期条数。 */
  get count(): number {
    return this.size;
  }

  /** 检查一条待发布排期；不改变已发布数据。 */
  check(pending: ScheduleInput): CheckResult {
    const a = parseSchedule(pending);
    const candidates = this.byPickupPoint.get(a.pickupPointId);
    if (!candidates || candidates.length === 0) return { canPublish: true };

    let best: {
      instant: number;
      existing: ParsedSchedule;
      sharedSku: string;
      openDateA: number;
      openDateB: number;
    } | null = null;

    for (const b of candidates) {
      // 共享 SKU 快速判定
      let sharedSku: string | null = null;
      const [small, large] =
        a.skuSet.size <= b.skuSet.size ? [a.skuSet, b.skuSet] : [b.skuSet, a.skuSet];
      for (const sku of small) {
        if (large.has(sku)) {
          sharedSku = sku;
          break;
        }
      }
      if (sharedSku === null) continue;
      if (best !== null) {
        // 下界剪枝：该既有排期最早可能场次的开放日已不早于当前最优。
        const earliestDay = Math.max(b.anchor, b.validFrom);
        if (earliestDay * 1440 >= best.instant) continue;
      }
      const conflict = earliestConflictBetween(a, b);
      if (conflict === null) continue;
      if (best === null || conflict.overlapStartUtc < best.instant) {
        best = {
          instant: conflict.overlapStartUtc,
          existing: b,
          sharedSku,
          openDateA: conflict.openDateA,
          openDateB: conflict.openDateB,
        };
      }
    }

    if (best === null) return { canPublish: true };
    return {
      canPublish: false,
      conflict: {
        earliestOverlapStartMinutesUtc: best.instant,
        earliestOverlapStartIsoUtc: utcMinutesToIsoString(best.instant),
        existingScheduleId: best.existing.id,
        sharedSku: best.sharedSku,
        pendingOpenDate: serialDayToDateString(best.openDateA),
        existingOpenDate: serialDayToDateString(best.openDateB),
      },
    };
  }
}
