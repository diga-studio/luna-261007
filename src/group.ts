/**
 * 并查集 + 每组聚合数据。
 * 每个逻辑客户（组）维护：是否已转化、以及 flowId -> 该渠道上的最早 day。
 */

export interface GroupData {
  /** 整组是否已转化（两组归并时取逻辑或）。 */
  converted: boolean;
  /** 该组出现过的每个 flowId 上的最早 day。 */
  earliest: Map<string, number>;
}

/**
 * 归并时对每个涉及渠道的回调。
 * - keptDay：归并后该渠道保留的（较早）日期；keptConverted：提供该日期的一侧在归并前是否已转化。
 * - droppedDay：被吞掉的（较晚）日期，仅当两侧都有该渠道时存在；
 *   droppedConverted：提供被吞日期的一侧在归并前是否已转化。
 */
export type FlowMergeHook = (
  flowId: string,
  keptDay: number,
  keptConverted: boolean,
  droppedDay: number | undefined,
  droppedConverted: boolean
) => void;

export class DisjointSet {
  private parent: number[] = [];
  /** 仅根节点有效；非根为 undefined。 */
  private data: (GroupData | undefined)[] = [];

  /** 新建一个单元素组，返回其内部下标。 */
  makeSet(flowId: string, day: number): number {
    const index = this.parent.length;
    this.parent.push(index);
    const earliest = new Map<string, number>();
    earliest.set(flowId, day);
    this.data.push({ converted: false, earliest });
    return index;
  }

  /** 查找下标所属组的根（带路径压缩）。 */
  find(index: number): number {
    let root = index;
    while (this.parent[root] !== root) {
      root = this.parent[root] as number;
    }
    let cur = index;
    while (this.parent[cur] !== root) {
      const next = this.parent[cur] as number;
      this.parent[cur] = root;
      cur = next;
    }
    return root;
  }

  /** 读取根节点的组数据（调用方需先 find）。 */
  groupData(root: number): GroupData {
    const d = this.data[root];
    if (d === undefined) {
      throw new Error("groupData called on non-root");
    }
    return d;
  }

  /**
   * 归并两个根所在的组，返回新根。
   * 按组内不同 flowId 数量决定挂接方向（小组并入大组），
   * 保证单条线索持续并入大组时单次归并只扫描小组的渠道表。
   */
  unionRoots(rootA: number, rootB: number, onFlow: FlowMergeHook): number {
    let bigRoot = rootA;
    let smallRoot = rootB;
    let big = this.groupData(rootA);
    let small = this.groupData(rootB);
    if (small.earliest.size > big.earliest.size) {
      const tmpRoot = bigRoot;
      bigRoot = smallRoot;
      smallRoot = tmpRoot;
      const tmpData = big;
      big = small;
      small = tmpData;
    }
    const bigConverted = big.converted;
    const smallConverted = small.converted;
    for (const [flowId, smallDay] of small.earliest) {
      const bigDay = big.earliest.get(flowId);
      if (bigDay === undefined) {
        big.earliest.set(flowId, smallDay);
        onFlow(flowId, smallDay, smallConverted, undefined, false);
      } else if (smallDay < bigDay) {
        big.earliest.set(flowId, smallDay);
        onFlow(flowId, smallDay, smallConverted, bigDay, bigConverted);
      } else {
        onFlow(flowId, bigDay, bigConverted, smallDay, smallConverted);
      }
    }
    big.converted = bigConverted || smallConverted;
    this.parent[smallRoot] = bigRoot;
    this.data[smallRoot] = undefined;
    return bigRoot;
  }
}
