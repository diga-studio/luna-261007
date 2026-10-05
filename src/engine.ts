import { AlertChange, Transaction } from "./types";

/** 窗口长度：24 小时（毫秒）。窗口为 (t - WINDOW_MS, t]。 */
export const WINDOW_MS = 24 * 60 * 60 * 1000;

/** 严格超阈：failed / total > 5%。整数运算避免浮点误差；空窗口（total=0）不超阈。 */
function isOverThreshold(failed: number, total: number): boolean {
  return failed * 20 > total;
}

/** 在升序数组中返回 > x 的第一个下标（即 <= x 的元素个数）。 */
function upperBound(sorted: number[], x: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]! <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 单个终端的已接受交易（已按 transaction_id 去重），含水位之后的暂存交易。 */
interface TerminalData {
  /** 与 failedFlags 对齐的时间戳；dirty 时尾部可能未排序。 */
  times: number[];
  failedFlags: boolean[];
  /** failedFlags 的前缀和（failedPrefix[i] = 前 i 条中失败数），仅排序后有效。 */
  failedPrefix: number[];
  dirty: boolean;
}

export class VaultPayAlertEngine {
  private watermark: number;
  private readonly seenIds = new Set<string>();
  private readonly terminals = new Map<string, TerminalData>();

  constructor(initialWatermark: number) {
    this.watermark = initialWatermark;
  }

  /** 批量接收交易；同一 ID 重复投递不增加计数；水位之后的交易暂存但不影响当前窗口。 */
  ingest(records: Transaction[]): void {
    for (const record of records) {
      if (this.seenIds.has(record.transaction_id)) continue;
      this.seenIds.add(record.transaction_id);
      let data = this.terminals.get(record.terminal_id);
      if (!data) {
        data = { times: [], failedFlags: [], failedPrefix: [0], dirty: false };
        this.terminals.set(record.terminal_id, data);
      }
      data.times.push(record.timestamp);
      data.failedFlags.push(record.status === "failed");
      data.dirty = true;
    }
  }

  /**
   * 单调推进水位，返回 (上次水位, 本次水位] 内的全部告警开始/结束变化。
   * 未结束区间只返回开始变化。结果按 (时刻, 终端) 排序，与输入排列及推进步长无关。
   */
  advanceWatermark(t: number): AlertChange[] {
    if (t < this.watermark) {
      throw new Error(`watermark cannot move backwards: ${t} < ${this.watermark}`);
    }
    if (t === this.watermark) return [];
    const prev = this.watermark;
    this.watermark = t;

    const changes: AlertChange[] = [];
    for (const [terminalId, data] of this.terminals) {
      this.collectTerminalChanges(terminalId, data, prev, t, changes);
    }
    changes.sort((a, b) =>
      a.timestamp !== b.timestamp
        ? a.timestamp - b.timestamp
        : a.terminal_id < b.terminal_id
          ? -1
          : a.terminal_id > b.terminal_id
            ? 1
            : a.type === b.type
              ? 0
              : a.type === "start"
                ? -1
                : 1,
    );
    return changes;
  }

  /** 扫描单个终端在 (prev, cur] 内的状态翻转，把变化追加到 out。 */
  private collectTerminalChanges(
    terminalId: string,
    data: TerminalData,
    prev: number,
    cur: number,
    out: AlertChange[],
  ): void {
    this.ensureSorted(data);
    const { times, failedPrefix } = data;

    // 进入窗口的事件：时间戳落在 (prev, cur] 的交易。
    const enterLo = upperBound(times, prev);
    const enterHi = upperBound(times, cur);
    // 离开窗口的事件：时间戳落在 (prev - H, cur - H] 的交易，于 ts + H 时刻退出。
    const exitLo = upperBound(times, prev - WINDOW_MS);
    const exitHi = upperBound(times, cur - WINDOW_MS);

    // prev 时刻的初始窗口状态（同一毫秒的全部变化作为整体生效后的状态）。
    let total = upperBound(times, prev) - upperBound(times, prev - WINDOW_MS);
    let failed = failedPrefix[upperBound(times, prev)]! - failedPrefix[upperBound(times, prev - WINDOW_MS)]!;
    let over = isOverThreshold(failed, total);

    // 双指针归并进入/退出事件，同一毫秒的事件聚成一组整体生效。
    let enterIdx = enterLo;
    let exitIdx = exitLo;
    while (enterIdx < enterHi || exitIdx < exitHi) {
      const nextEnter = enterIdx < enterHi ? times[enterIdx]! : Number.POSITIVE_INFINITY;
      const nextExit = exitIdx < exitHi ? times[exitIdx]! + WINDOW_MS : Number.POSITIVE_INFINITY;
      const eventTime = Math.min(nextEnter, nextExit);
      while (enterIdx < enterHi && times[enterIdx]! === eventTime) {
        total += 1;
        failed += failedPrefix[enterIdx + 1]! - failedPrefix[enterIdx]!;
        enterIdx += 1;
      }
      while (exitIdx < exitHi && times[exitIdx]! + WINDOW_MS === eventTime) {
        total -= 1;
        failed -= failedPrefix[exitIdx + 1]! - failedPrefix[exitIdx]!;
        exitIdx += 1;
      }
      const nowOver = isOverThreshold(failed, total);
      if (nowOver !== over) {
        out.push({ terminal_id: terminalId, type: nowOver ? "start" : "end", timestamp: eventTime });
        over = nowOver;
      }
    }
  }

  /** 惰性排序并重建失败数前缀和。 */
  private ensureSorted(data: TerminalData): void {
    if (!data.dirty) return;
    const order = data.times.map((_, i) => i).sort((a, b) => data.times[a]! - data.times[b]!);
    const sortedTimes: number[] = new Array<number>(order.length);
    const sortedFailed: boolean[] = new Array<boolean>(order.length);
    const prefix: number[] = new Array<number>(order.length + 1);
    prefix[0] = 0;
    for (let i = 0; i < order.length; i++) {
      sortedTimes[i] = data.times[order[i]!]!;
      sortedFailed[i] = data.failedFlags[order[i]!]!;
      prefix[i + 1] = prefix[i]! + (sortedFailed[i] ? 1 : 0);
    }
    data.times = sortedTimes;
    data.failedFlags = sortedFailed;
    data.failedPrefix = prefix;
    data.dirty = false;
  }
}
