import type { Day, DayCounts, FunnelReport, FlowId } from "./types.js";

interface DaySlot {
  day: Day;
  captured: number;
  converted: number;
}

/**
 * 单个 flowId 的按日计数表。
 *
 * - 点更新：二分定位 O(log n)，命中直接改；未命中插入新槽位。
 * - 区间查询：懒维护前缀和（更新时置脏，查询时按需重建），
 *   之后每次 report 只需两次二分，不扫描任何日期槽位。
 * 只持有本 flowId 自己的数据，不接触其他渠道。
 */
export class FlowStats {
  private slots: DaySlot[] = [];
  private prefixCaptured: number[] = [];
  private prefixConverted: number[] = [];
  private dirty = false;

  addCaptured(day: Day, delta: number): void {
    this.slot(day).captured += delta;
    this.dirty = true;
  }

  addConverted(day: Day, delta: number): void {
    this.slot(day).converted += delta;
    this.dirty = true;
  }

  at(day: Day): DayCounts {
    const idx = this.locate(day);
    if (idx >= 0) {
      const s = this.slots[idx]!;
      return { captured: s.captured, converted: s.converted };
    }
    return { captured: 0, converted: 0 };
  }

  query(flowId: FlowId, fromDay: Day, toDay: Day): FunnelReport {
    this.ensurePrefixes();
    const lo = this.lowerBound(fromDay);
    const hi = this.upperBound(toDay);
    const days = [];
    for (let i = lo; i < hi; i++) {
      const s = this.slots[i]!;
      if (s.captured !== 0 || s.converted !== 0) {
        days.push({ day: s.day, captured: s.captured, converted: s.converted });
      }
    }
    return {
      flowId,
      fromDay,
      toDay,
      days,
      totalCaptured: this.prefixAt(hi, this.prefixCaptured) - this.prefixAt(lo, this.prefixCaptured),
      totalConverted: this.prefixAt(hi, this.prefixConverted) - this.prefixAt(lo, this.prefixConverted),
    };
  }

  private prefixAt(endExclusive: number, prefix: number[]): number {
    return endExclusive === 0 ? 0 : prefix[endExclusive - 1]!;
  }

  /** 返回 day 所在下标；不存在则返回 -(插入点 + 1)。 */
  private locate(day: Day): number {
    let lo = 0;
    let hi = this.slots.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const d = this.slots[mid]!.day;
      if (d === day) return mid;
      if (d < day) lo = mid + 1;
      else hi = mid;
    }
    return -lo - 1;
  }

  private slot(day: Day): DaySlot {
    const idx = this.locate(day);
    if (idx >= 0) return this.slots[idx]!;
    const at = -idx - 1;
    const created: DaySlot = { day, captured: 0, converted: 0 };
    this.slots.splice(at, 0, created);
    return created;
  }

  private lowerBound(day: Day): number {
    const idx = this.locate(day);
    return idx >= 0 ? idx : -idx - 1;
  }

  private upperBound(day: Day): number {
    const idx = this.locate(day);
    return idx >= 0 ? idx + 1 : -idx - 1;
  }

  private ensurePrefixes(): void {
    if (!this.dirty) return;
    const n = this.slots.length;
    this.prefixCaptured.length = n;
    this.prefixConverted.length = n;
    let captured = 0;
    let converted = 0;
    for (let i = 0; i < n; i++) {
      captured += this.slots[i]!.captured;
      converted += this.slots[i]!.converted;
      this.prefixCaptured[i] = captured;
      this.prefixConverted[i] = converted;
    }
    this.dirty = false;
  }
}
