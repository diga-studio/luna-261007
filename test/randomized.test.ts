import test from "node:test";
import assert from "node:assert/strict";
import { AlertTracker } from "../src/index.js";
import type {
  AlertDiff,
  AlertInterval,
  Outcome,
  Report,
  StreamKey,
} from "../src/index.js";

const MIN_LEN = 6;

/** 确定性伪随机数生成器（mulberry32）。 */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 测试内独立的全量重算模型：只依赖题目规则，不依赖被测实现。 */
class Model {
  private readonly jobs = new Map<string, Map<number, { revision: number; outcome: Outcome }>>();
  private readonly alerts = new Map<string, AlertInterval[]>();

  private static keyOf(stream: StreamKey): string {
    return `${stream.deviceId}#${stream.applicationId}`;
  }

  apply(report: Report): AlertDiff {
    const key = Model.keyOf(report);
    let jobs = this.jobs.get(key);
    if (jobs === undefined) {
      jobs = new Map();
      this.jobs.set(key, jobs);
    }
    const cur = jobs.get(report.seq);
    if (cur !== undefined && cur.revision >= report.revision) {
      return { added: [], removed: [] };
    }
    jobs.set(report.seq, { revision: report.revision, outcome: report.outcome });

    const next = Model.computeAlerts(jobs);
    const prev = this.alerts.get(key) ?? [];
    this.alerts.set(key, next);
    return {
      added: next.filter((n) => !prev.some((o) => o.start === n.start && o.end === n.end)),
      removed: prev.filter((o) => !next.some((n) => o.start === n.start && o.end === n.end)),
    };
  }

  listAlerts(stream: StreamKey): AlertInterval[] {
    return this.alerts.get(Model.keyOf(stream)) ?? [];
  }

  private static computeAlerts(
    jobs: Map<number, { revision: number; outcome: Outcome }>,
  ): AlertInterval[] {
    const seqs = [...jobs.keys()].sort((a, b) => a - b);
    const result: AlertInterval[] = [];
    let runStart = -1;
    let prev = -1;
    for (const seq of seqs) {
      const failed = jobs.get(seq)!.outcome === "Failed";
      const extendsRun = failed && runStart >= 0 && seq === prev + 1;
      if (!extendsRun) {
        if (runStart >= 0 && prev - runStart + 1 >= MIN_LEN) {
          result.push({ start: runStart, end: prev });
        }
        runStart = failed ? seq : -1;
      }
      prev = seq;
    }
    if (runStart >= 0 && prev - runStart + 1 >= MIN_LEN) {
      result.push({ start: runStart, end: prev });
    }
    return result;
  }
}

function sorted(intervals: AlertInterval[]): AlertInterval[] {
  return [...intervals].sort((a, b) => a.start - b.start || a.end - b.end);
}

test("固定种子随机多流乱序修订：每步与全量重算模型核对", () => {
  const rng = makeRng(20261007);
  const streams: StreamKey[] = [
    { deviceId: "dev-a", applicationId: "app-1" },
    { deviceId: "dev-a", applicationId: "app-2" },
    { deviceId: "dev-b", applicationId: "app-1" },
    { deviceId: "dev-c", applicationId: "app-9" },
  ];
  const MAX_SEQ = 40;
  const OPS = 2000;

  const tracker = new AlertTracker();
  const model = new Model();
  // 生成器侧记录的当前最高 revision，用于制造过期/重复/修订上报。
  const maxRevision = new Map<string, number>();

  for (let step = 0; step < OPS; step++) {
    const stream = streams[Math.floor(rng() * streams.length)]!;
    const seq = 1 + Math.floor(rng() * MAX_SEQ);
    const jobKey = `${stream.deviceId}#${stream.applicationId}#${seq}`;
    const curMax = maxRevision.get(jobKey) ?? 0;

    const kind = rng();
    let revision: number;
    if (curMax === 0) {
      revision = 1 + Math.floor(rng() * 3);
    } else if (kind < 0.25) {
      revision = 1 + Math.floor(rng() * curMax); // 过期版本
    } else if (kind < 0.45) {
      revision = curMax; // 重复版本
    } else {
      revision = curMax + 1 + Math.floor(rng() * 2); // 修订版本
    }
    const outcome: Outcome = rng() < 0.55 ? "Failed" : "Installed";
    const report: Report = { ...stream, seq, revision, outcome };

    const actual = tracker.apply(report);
    const expected = model.apply(report);

    assert.deepEqual(
      sorted(actual.added),
      sorted(expected.added),
      `step ${step} added, report=${JSON.stringify(report)}`,
    );
    assert.deepEqual(
      sorted(actual.removed),
      sorted(expected.removed),
      `step ${step} removed, report=${JSON.stringify(report)}`,
    );
    assert.deepEqual(
      sorted(tracker.listAlerts(stream)),
      sorted(model.listAlerts(stream)),
      `step ${step} listAlerts, stream=${JSON.stringify(stream)}`,
    );

    if (revision > curMax) maxRevision.set(jobKey, revision);
  }

  // 收尾：对所有流整体再核对一次当前告警集合。
  for (const stream of streams) {
    assert.deepEqual(
      sorted(tracker.listAlerts(stream)),
      sorted(model.listAlerts(stream)),
      `final listAlerts, stream=${JSON.stringify(stream)}`,
    );
  }
});
