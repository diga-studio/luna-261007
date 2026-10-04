import test from "node:test";
import assert from "node:assert/strict";
import { AlertTracker, MIN_ALERT_LENGTH } from "../src/alert-tracker";
import { AlertInterval, Outcome, Report, StreamKey } from "../src/types";

/** 确定性 PRNG（mulberry32），固定种子保证可复现。 */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface ModelEntry {
  revision: number;
  outcome: Outcome;
}

/** 测试内独立的全量重算模型。 */
class Model {
  private readonly results = new Map<number, ModelEntry>();
  private alerts: AlertInterval[] = [];

  constructor(private readonly tracker: AlertTracker, private readonly stream: StreamKey) {}

  apply(report: Report): void {
    const existing = this.results.get(report.seq);
    if (existing === undefined || existing.revision < report.revision) {
      this.results.set(report.seq, { revision: report.revision, outcome: report.outcome });
    }

    const next = this.recompute();
    const expected = {
      added: next.filter((i) => !this.alerts.some((j) => same(i, j))),
      removed: this.alerts.filter((i) => !next.some((j) => same(i, j))),
    };
    this.alerts = next;

    const actual = this.tracker.apply(report);
    assert.deepEqual(
      normalize(actual.added),
      normalize(expected.added),
      `added mismatch after ${JSON.stringify(report)}`
    );
    assert.deepEqual(
      normalize(actual.removed),
      normalize(expected.removed),
      `removed mismatch after ${JSON.stringify(report)}`
    );
  }

  checkList(): void {
    assert.deepEqual(
      normalize(this.tracker.listAlerts(this.stream)),
      normalize(this.alerts),
      `listAlerts mismatch for ${JSON.stringify(this.stream)}`
    );
  }

  private recompute(): AlertInterval[] {
    const seqs = [...this.results.keys()].sort((a, b) => a - b);
    const alerts: AlertInterval[] = [];
    let start: number | null = null;
    let prev = 0;
    const flush = (end: number) => {
      if (start !== null && end - start + 1 >= MIN_ALERT_LENGTH) {
        alerts.push({ start, end });
      }
      start = null;
    };
    for (const seq of seqs) {
      const failed = this.results.get(seq)!.outcome === "Failed";
      if (failed) {
        if (start === null || seq !== prev + 1) {
          flush(prev);
          start = seq;
        }
      } else {
        flush(prev);
      }
      prev = seq;
    }
    flush(prev);
    return alerts;
  }
}

function same(a: AlertInterval, b: AlertInterval): boolean {
  return a.start === b.start && a.end === b.end;
}

function normalize(intervals: AlertInterval[]): AlertInterval[] {
  return [...intervals].sort((a, b) => a.start - b.start || a.end - b.end);
}

test("固定种子随机多流乱序修订，逐步与全量重算模型核对", () => {
  const rand = mulberry32(20261004);
  const pick = <T>(items: T[]): T => items[Math.floor(rand() * items.length)]!;

  const streams: StreamKey[] = [];
  for (const deviceId of ["dev-a", "dev-b"]) {
    for (const applicationId of ["app-x", "app-y"]) {
      streams.push({ deviceId, applicationId });
    }
  }

  const tracker = new AlertTracker();
  const models = new Map(streams.map((s) => [`${s.deviceId}/${s.applicationId}`, new Model(tracker, s)]));

  const outcomes: Outcome[] = ["Installed", "Failed", "Failed"]; // 偏向失败以形成区间
  for (let step = 0; step < 3000; step++) {
    const stream = pick(streams);
    const report: Report = {
      ...stream,
      seq: 1 + Math.floor(rand() * 30),
      revision: 1 + Math.floor(rand() * 5),
      outcome: pick(outcomes),
    };
    models.get(`${stream.deviceId}/${stream.applicationId}`)!.apply(report);
  }

  for (const model of models.values()) {
    model.checkList();
  }
});
