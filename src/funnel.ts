import { DisjointSet } from "./group";
import type { ReportEntry } from "./types";

type DayTable = Map<string, Map<number, number>>;

/**
 * 线索归并后的增量漏斗统计。
 * 查重结果由调用者通过 merge 提供，本库只维护归并后的按渠道、按日统计。
 *
 * 不变式：每个逻辑客户（并查集中的组）在它出现过的每个 flowId 上，
 * 于该组在该 flowId 的最早 day 处贡献 1 次 captured；
 * 若该组已转化，同时在同一 (flowId, day) 处贡献 1 次 converted。
 */
export class FunnelStats {
  private idToIndex = new Map<string, number>();
  private dsu = new DisjointSet();
  /** flowId -> (day -> captured 计数)。 */
  private captured: DayTable = new Map();
  /** flowId -> (day -> converted 计数)。 */
  private converted: DayTable = new Map();

  /** 新增一条未转化的原始线索。id 全局唯一。 */
  add(id: string, flowId: string, day: number): void {
    const index = this.dsu.makeSet(flowId, day);
    this.idToIndex.set(id, index);
    this.bump(this.captured, flowId, day, 1);
  }

  /** 将 id 当前所属的整组标记为已转化；重复调用无额外影响。 */
  convert(id: string): void {
    const data = this.dsu.groupData(this.dsu.find(this.indexOf(id)));
    if (data.converted) {
      return;
    }
    data.converted = true;
    for (const [flowId, day] of data.earliest) {
      this.bump(this.converted, flowId, day, 1);
    }
  }

  /** 归并两个 id 所属的整组；同组归并无影响。已转化状态取逻辑或。 */
  merge(a: string, b: string): void {
    const rootA = this.dsu.find(this.indexOf(a));
    const rootB = this.dsu.find(this.indexOf(b));
    if (rootA === rootB) {
      return;
    }
    // 仅一侧已转化时，未转化侧的全部渠道贡献先转为已转化。
    // 每组至多经历一次这种状态翻转，之后归并不再触发该扫描。
    const dataA = this.dsu.groupData(rootA);
    const dataB = this.dsu.groupData(rootB);
    if (dataA.converted !== dataB.converted) {
      const unconverted = dataA.converted ? dataB : dataA;
      for (const [flowId, day] of unconverted.earliest) {
        this.bump(this.converted, flowId, day, 1);
      }
      unconverted.converted = true;
    }
    const finalConverted =
      this.dsu.groupData(rootA).converted || this.dsu.groupData(rootB).converted;
    const finalDelta = finalConverted ? 1 : 0;
    this.dsu.unionRoots(rootA, rootB, (flowId, keptDay, keptConverted, droppedDay, droppedConverted) => {
      // 保留日期处：归并后该组的 converted 贡献由 keptConverted 变为 finalConverted。
      this.bump(this.converted, flowId, keptDay, finalDelta - (keptConverted ? 1 : 0));
      if (droppedDay !== undefined) {
        // 被吞日期处：两组各自的 captured/converted 贡献随较晚日期一起消失。
        this.bump(this.captured, flowId, droppedDay, -1);
        this.bump(this.converted, flowId, droppedDay, -(droppedConverted ? 1 : 0));
      }
    });
  }

  /** 返回该渠道在闭区间 [fromDay, toDay] 内按日的 captured/converted。 */
  report(flowId: string, fromDay: number, toDay: number): ReportEntry[] {
    const cap = this.captured.get(flowId);
    const conv = this.converted.get(flowId);
    const out: ReportEntry[] = [];
    for (let day = fromDay; day <= toDay; day++) {
      out.push({
        day,
        captured: cap === undefined ? 0 : cap.get(day) ?? 0,
        converted: conv === undefined ? 0 : conv.get(day) ?? 0,
      });
    }
    return out;
  }

  private indexOf(id: string): number {
    const index = this.idToIndex.get(id);
    if (index === undefined) {
      throw new Error(`unknown id: ${id}`);
    }
    return index;
  }

  private bump(table: DayTable, flowId: string, day: number, delta: number): void {
    if (delta === 0) {
      return;
    }
    let byDay = table.get(flowId);
    if (byDay === undefined) {
      byDay = new Map();
      table.set(flowId, byDay);
    }
    const next = (byDay.get(day) ?? 0) + delta;
    if (next === 0) {
      byDay.delete(day);
    } else {
      byDay.set(day, next);
    }
  }
}
