import type {
  AlertDiff,
  AlertInterval,
  Outcome,
  Report,
  StreamKey,
} from "./types.js";

/** 连续失败达到该长度才构成告警。 */
export const ALERT_MIN_LENGTH = 6;

interface JobRecord {
  revision: number;
  outcome: Outcome;
}

/** 单条流的可变状态。 */
class StreamState {
  /** 已知的有效结果，按 seq 升序排列，与 records 一一对应。 */
  readonly seqs: number[] = [];
  readonly records = new Map<number, JobRecord>();
  /** 当前告警区间，按 start 升序。 */
  alerts: AlertInterval[] = [];

  /** 返回 seq 应插入/所在位置的下标；存在时 found 为 true。 */
  locate(seq: number): { index: number; found: boolean } {
    let lo = 0;
    let hi = this.seqs.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const v = this.seqs[mid]!;
      if (v === seq) return { index: mid, found: true };
      if (v < seq) lo = mid + 1;
      else hi = mid;
    }
    return { index: lo, found: false };
  }

  /** 根据全部有效结果重算告警区间。 */
  recompute(): AlertInterval[] {
    const result: AlertInterval[] = [];
    let runStart = -1;
    let prev = -1;
    for (const seq of this.seqs) {
      const failed = this.records.get(seq)!.outcome === "Failed";
      const extendsRun = failed && runStart >= 0 && seq === prev + 1;
      if (!extendsRun) {
        // 成功或缺口都会截断当前失败段；先结算再视情况开新段。
        if (runStart >= 0 && prev - runStart + 1 >= ALERT_MIN_LENGTH) {
          result.push({ start: runStart, end: prev });
        }
        runStart = failed ? seq : -1;
      }
      prev = seq;
    }
    if (runStart >= 0 && prev - runStart + 1 >= ALERT_MIN_LENGTH) {
      result.push({ start: runStart, end: prev });
    }
    return result;
  }
}

function sameInterval(a: AlertInterval, b: AlertInterval): boolean {
  return a.start === b.start && a.end === b.end;
}

/** 两个按 start 升序的区间列表求差分。 */
function diffAlerts(
  oldAlerts: AlertInterval[],
  newAlerts: AlertInterval[],
): AlertDiff {
  const added = newAlerts.filter(
    (n) => !oldAlerts.some((o) => sameInterval(o, n)),
  );
  const removed = oldAlerts.filter(
    (o) => !newAlerts.some((n) => sameInterval(o, n)),
  );
  return { added, removed };
}

function streamId(stream: StreamKey): string {
  return `${stream.deviceId}\u0000${stream.applicationId}`;
}

export class AlertTracker {
  private readonly streams = new Map<string, StreamState>();

  /**
   * 接受一条上报，返回本次调用新增与移除的告警区间。
   * 过期（更低 revision）或重复（相同 revision）上报返回空差分。
   */
  apply(report: Report): AlertDiff {
    if (
      !Number.isInteger(report.seq) ||
      report.seq <= 0 ||
      !Number.isInteger(report.revision) ||
      report.revision < 0
    ) {
      throw new Error(`invalid report: ${JSON.stringify(report)}`);
    }

    const id = streamId(report);
    let state = this.streams.get(id);
    if (state === undefined) {
      state = new StreamState();
      this.streams.set(id, state);
    }

    const existing = state.records.get(report.seq);
    if (existing !== undefined && existing.revision >= report.revision) {
      // 重复或过期上报：有效状态不变，差分为空。
      return { added: [], removed: [] };
    }

    const { index, found } = state.locate(report.seq);
    if (!found) {
      state.seqs.splice(index, 0, report.seq);
    }
    state.records.set(report.seq, {
      revision: report.revision,
      outcome: report.outcome,
    });

    const next = state.recompute();
    const diff = diffAlerts(state.alerts, next);
    state.alerts = next;
    return diff;
  }

  /** 返回该流当前全部告警区间，按 start 升序。 */
  listAlerts(stream: StreamKey): AlertInterval[] {
    const state = this.streams.get(streamId(stream));
    if (state === undefined) return [];
    return state.alerts.map((a) => ({ ...a }));
  }
}
