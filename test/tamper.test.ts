import { test } from "node:test";
import assert from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { Ledger, verifyReport } from "../src/index.js";
import type { Credential, CustodyReport } from "../src/index.js";
import { tempDbPath } from "./helpers.js";

interface Fixture {
  path: string;
  credential: Credential;
  otherCredential: Credential;
}

function buildFixture(): Fixture {
  const path = tempDbPath("tamper.db");
  const ledger = Ledger.open(path);
  // 记录 A：5 个事件，其中 seq 2/3/4 同秒。
  ledger.appendEvent({ recordId: "A", timestamp: 100, operator: "op1", body: "a-first" });
  ledger.appendEvent({ recordId: "A", timestamp: 200, operator: "op2", body: "a-second" });
  ledger.appendEvent({ recordId: "A", timestamp: 200, operator: "op3", body: "a-third" });
  ledger.appendEvent({ recordId: "A", timestamp: 200, operator: "op4", body: "a-fourth" });
  ledger.appendEvent({ recordId: "A", timestamp: 300, operator: "op5", body: "a-fifth" });
  // 记录 B：3 个事件。
  ledger.appendEvent({ recordId: "B", timestamp: 150, operator: "op1", body: "b-first" });
  ledger.appendEvent({ recordId: "B", timestamp: 250, operator: "op2", body: "b-second" });
  ledger.appendEvent({ recordId: "B", timestamp: 350, operator: "op3", body: "b-third" });
  // 记录 C：1 个事件。
  ledger.appendEvent({ recordId: "C", timestamp: 50, operator: "op9", body: "c-only" });
  const credential = ledger.seal();
  ledger.close();

  const otherPath = tempDbPath("other.db");
  const other = Ledger.open(otherPath);
  other.appendEvent({ recordId: "A", timestamp: 100, operator: "op1", body: "a-first" });
  const otherCredential = other.seal();
  other.close();

  return { path, credential, otherCredential };
}

function clone(report: CustodyReport): CustodyReport {
  return JSON.parse(JSON.stringify(report)) as CustodyReport;
}

const fixture = buildFixture();

function reportOf(recordId: string): CustodyReport {
  const ledger = Ledger.open(fixture.path);
  const report = ledger.generateReport(recordId);
  ledger.close();
  return report;
}

test("合法报告作为对照可通过验真", () => {
  assert.ok(verifyReport(fixture.credential, "A", reportOf("A")));
  assert.ok(verifyReport(fixture.credential, "B", reportOf("B")));
  assert.ok(verifyReport(fixture.credential, "MISSING", reportOf("MISSING")));
});

test("删掉中间事件不能通过", () => {
  const report = clone(reportOf("A"));
  report.events.splice(2, 1);
  assert.ok(!verifyReport(fixture.credential, "A", report));
});

test("删掉首事件不能通过", () => {
  const report = clone(reportOf("A"));
  report.events.shift();
  assert.ok(!verifyReport(fixture.credential, "A", report));
});

test("删掉尾事件不能通过", () => {
  const report = clone(reportOf("A"));
  report.events.pop();
  assert.ok(!verifyReport(fixture.credential, "A", report));
});

test("交换同秒事件不能通过", () => {
  const report = clone(reportOf("A"));
  // seq 2/3/4 同秒（timestamp 200），在报告中相邻。
  const i1 = report.events.findIndex((e) => e.seq === 2);
  const i2 = report.events.findIndex((e) => e.seq === 3);
  const tmp = report.events[i1]!;
  report.events[i1] = report.events[i2]!;
  report.events[i2] = tmp;
  assert.ok(!verifyReport(fixture.credential, "A", report));
});

test("替换正文不能通过", () => {
  const report = clone(reportOf("A"));
  report.events[0]!.body = "forged-body";
  assert.ok(!verifyReport(fixture.credential, "A", report));
});

test("替换操作者或时间不能通过", () => {
  const byOperator = clone(reportOf("A"));
  byOperator.events[1]!.operator = "mallory";
  assert.ok(!verifyReport(fixture.credential, "A", byOperator));

  const byTime = clone(reportOf("A"));
  byTime.events[1]!.timestamp += 1;
  // 时间改动后需保持排序合法才能走到链校验；无论哪条路径都必须失败。
  assert.ok(!verifyReport(fixture.credential, "A", byTime));
});

test("拼入另一记录的事件不能通过", () => {
  const reportA = clone(reportOf("A"));
  const reportB = reportOf("B");
  // 把 B 的一个事件拼进 A 的报告（按 (ts, seq) 插入正确位置以保持排序）。
  const foreign = reportB.events[0]!;
  const merged = [...reportA.events, foreign].sort(
    (x, y) => x.timestamp - y.timestamp || x.seq - y.seq,
  );
  reportA.events = merged;
  assert.ok(!verifyReport(fixture.credential, "A", reportA));
});

test("拼入另一记录的校验材料不能通过", () => {
  const reportA = clone(reportOf("A"));
  const reportB = reportOf("B");
  reportA.proof = reportB.proof;
  assert.ok(!verifyReport(fixture.credential, "A", reportA));
});

test("把存在记录伪报为空不能通过", () => {
  // 用不存在记录的空报告冒充记录 A。
  const empty = clone(reportOf("MISSING"));
  empty.recordId = "A";
  assert.ok(!verifyReport(fixture.credential, "A", empty));

  // 用 A 的真报告删掉全部事件并换成空报告证明。
  const stripped = clone(reportOf("A"));
  stripped.events = [];
  stripped.proof = reportOf("MISSING").proof;
  assert.ok(!verifyReport(fixture.credential, "A", stripped));
});

test("把空记录伪报为存在不能通过", () => {
  const forged = clone(reportOf("A"));
  forged.recordId = "MISSING";
  assert.ok(!verifyReport(fixture.credential, "MISSING", forged));
});

test("使用另一账册的凭证不能通过", () => {
  assert.ok(!verifyReport(fixture.otherCredential, "A", reportOf("A")));
  assert.ok(!verifyReport(fixture.otherCredential, "MISSING", reportOf("MISSING")));
});

test("账册文件被改动后无法生成仍可通过验真的错误报告", () => {
  // 直接篡改库文件中的事件正文。
  const db = new DatabaseSync(fixture.path);
  db.prepare("UPDATE events SET body = ? WHERE seq = ?").run("tampered-body", 2);
  db.close();

  const ledger = Ledger.open(fixture.path);
  const tampered = ledger.generateReport("A");
  ledger.close();
  assert.ok(!verifyReport(fixture.credential, "A", tampered));

  // 篡改封存目录（把记录 A 的链头换成别的记录的）。
  const db2 = new DatabaseSync(fixture.path);
  db2.exec(`
    UPDATE records SET head = (
      SELECT r2.head FROM records r2 WHERE r2.key != records.key LIMIT 1
    )
    WHERE count = 5
  `);
  db2.close();

  const ledger2 = Ledger.open(fixture.path);
  const tampered2 = ledger2.generateReport("A");
  ledger2.close();
  assert.ok(!verifyReport(fixture.credential, "A", tampered2));
});
