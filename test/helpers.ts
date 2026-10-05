import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/index.js";
import type { CustodyEvent, EventInput } from "../src/index.js";

export function tempDbPath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ec-test-"));
  return join(dir, name);
}

/** 独立遍历原始事件，得到某记录应有的报告事件序列（按时间升序、同秒按序号）。 */
export function expectedReportEvents(
  events: Array<EventInput & { seq: number }>,
  recordId: string,
): Array<{ seq: number; timestamp: number; operator: string; body: string }> {
  return events
    .filter((e) => e.recordId === recordId)
    .map((e) => ({ seq: e.seq, timestamp: e.timestamp, operator: e.operator, body: e.body }))
    .sort((a, b) => a.timestamp - b.timestamp || a.seq - b.seq);
}

export function appendTracked(
  ledger: Ledger,
  inputs: EventInput[],
): Array<EventInput & { seq: number }> {
  return inputs.map((input) => ({ ...input, seq: ledger.appendEvent(input) }));
}

export type { CustodyEvent, EventInput };
