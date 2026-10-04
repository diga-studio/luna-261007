import { AlertInterval, ApplyResult, Report, StreamKey } from "./types";

export const MIN_ALERT_LENGTH = 6;

interface EffectiveResult {
  revision: number;
  outcome: "Installed" | "Failed";
}

interface StreamState {
  /** seq -> 当前有效结果（已收到的最高 revision）。 */
  results: Map<number, EffectiveResult>;
  /** 当前告警区间，按 start 升序。 */
  alerts: AlertInterval[];
}

function streamId(stream: StreamKey): string {
  return `${stream.deviceId}${stream.applicationId}`;
}

function intervalKey(interval: AlertInterval): string {
  return `${interval.start}:${interval.end}`;
}

/** 由流的全部有效结果全量重算告警区间。 */
function computeAlerts(results: Map<number, EffectiveResult>): AlertInterval[] {
  const seqs = [...results.keys()].sort((a, b) => a - b);
  const alerts: AlertInterval[] = [];
  let runStart: number | null = null;
  let prevSeq = 0;

  const flush = (endSeq: number) => {
    if (runStart !== null && endSeq - runStart + 1 >= MIN_ALERT_LENGTH) {
      alerts.push({ start: runStart, end: endSeq });
    }
    runStart = null;
  };

  for (const seq of seqs) {
    const failed = results.get(seq)!.outcome === "Failed";
    const continues = runStart !== null && seq === prevSeq + 1;
    if (failed && !continues) {
      flush(prevSeq);
      runStart = seq;
    } else if (!failed) {
      flush(prevSeq);
    }
    prevSeq = seq;
  }
  flush(prevSeq);
  return alerts;
}

function diffAlerts(
  before: AlertInterval[],
  after: AlertInterval[]
): ApplyResult {
  const beforeKeys = new Set(before.map(intervalKey));
  const afterKeys = new Set(after.map(intervalKey));
  return {
    added: after.filter((i) => !beforeKeys.has(intervalKey(i))),
    removed: before.filter((i) => !afterKeys.has(intervalKey(i))),
  };
}

export class AlertTracker {
  private readonly streams = new Map<string, StreamState>();

  apply(report: Report): ApplyResult {
    const id = streamId(report);
    let state = this.streams.get(id);
    if (state === undefined) {
      state = { results: new Map(), alerts: [] };
      this.streams.set(id, state);
    }

    const existing = state.results.get(report.seq);
    if (existing !== undefined && existing.revision >= report.revision) {
      // 过期或重复上报：有效状态不变，差分必为空。
      return { added: [], removed: [] };
    }
    state.results.set(report.seq, {
      revision: report.revision,
      outcome: report.outcome,
    });

    const next = computeAlerts(state.results);
    const diff = diffAlerts(state.alerts, next);
    state.alerts = next;
    return diff;
  }

  listAlerts(stream: StreamKey): AlertInterval[] {
    const state = this.streams.get(streamId(stream));
    if (state === undefined) {
      return [];
    }
    return state.alerts.map((i) => ({ ...i }));
  }
}
