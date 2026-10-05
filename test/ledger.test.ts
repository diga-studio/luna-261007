import { test } from "node:test";
import assert from "node:assert";
import { Ledger, verifyReport } from "../src/index.js";
import type { EventInput } from "../src/index.js";
import { appendTracked, expectedReportEvents, tempDbPath } from "./helpers.js";

function buildInterleavedLedger(): {
  path: string;
  inputs: Array<EventInput & { seq: number }>;
  credential: Uint8Array;
} {
  const path = tempDbPath("interleaved.db");
  const ledger = Ledger.open(path);

  // 5 个记录交错追加，大批事件共享同一秒。
  const records = ["ALPHA", "BRAVO", "CHARLIE", "DELTA", "ECHO"];
  const inputs: EventInput[] = [];
  const baseTs = 1_700_000_000;
  for (let i = 0; i < 2000; i++) {
    const recordId = records[i % records.length]!;
    // 每 50 个事件才推进一秒，制造大量同秒事件；偶尔时间回退。
    let timestamp = baseTs + Math.floor(i / 50);
    if (i % 401 === 400) timestamp = baseTs; // 故意乱序的时间
    inputs.push({
      recordId,
      timestamp,
      operator: `op-${i % 7}`,
      body: `event-body-${i}`,
    });
  }
  const tracked = appendTracked(ledger, inputs);

  // 全局序号唯一且从 1 开始递增。
  tracked.forEach((e, idx) => assert.strictEqual(e.seq, idx + 1));

  const credential = ledger.seal();
  ledger.close();
  return { path, inputs: tracked, credential };
}

test("交错追加与同秒事件：报告与独立遍历一致，非空与空报告均通过验真", () => {
  const { path, inputs, credential } = buildInterleavedLedger();
  assert.ok(credential.length <= 128, "credential must be <= 128 bytes");

  // 关闭后重新打开仍可生成报告。
  const ledger = Ledger.open(path);
  assert.ok(ledger.sealed);

  for (const recordId of ["ALPHA", "BRAVO", "CHARLIE", "DELTA", "ECHO"]) {
    const report = ledger.generateReport(recordId);
    const expected = expectedReportEvents(inputs, recordId);
    assert.deepStrictEqual(report.events, expected, `report mismatch for ${recordId}`);
    assert.ok(verifyReport(credential, recordId, report), `verify failed for ${recordId}`);
  }

  // 空报告：记录不存在。
  const empty = ledger.generateReport("NO-SUCH-RECORD");
  assert.deepStrictEqual(empty.events, []);
  assert.ok(verifyReport(credential, "NO-SUCH-RECORD", empty), "empty report must verify");

  ledger.close();
});

test("封存后只读：追加与重复封存均抛错", () => {
  const path = tempDbPath("readonly.db");
  const ledger = Ledger.open(path);
  ledger.appendEvent({ recordId: "R", timestamp: 1, operator: "a", body: "b" });
  ledger.seal();
  assert.throws(
    () => ledger.appendEvent({ recordId: "R", timestamp: 2, operator: "a", body: "b" }),
    /sealed/,
  );
  assert.throws(() => ledger.seal(), /already sealed/);
  ledger.close();

  // 重新打开后依然只读。
  const reopened = Ledger.open(path);
  assert.throws(
    () => reopened.appendEvent({ recordId: "R", timestamp: 3, operator: "a", body: "b" }),
    /sealed/,
  );
  assert.throws(() => reopened.seal(), /already sealed/);
  reopened.close();
});

test("未封存时不能生成报告", () => {
  const path = tempDbPath("unsealed.db");
  const ledger = Ledger.open(path);
  ledger.appendEvent({ recordId: "R", timestamp: 1, operator: "a", body: "b" });
  assert.throws(() => ledger.generateReport("R"), /not sealed/);
  ledger.close();
});

test("空账册封存后空报告可验真", () => {
  const path = tempDbPath("empty.db");
  const ledger = Ledger.open(path);
  const credential = ledger.seal();
  ledger.close();

  const reopened = Ledger.open(path);
  const report = reopened.generateReport("ANYTHING");
  assert.deepStrictEqual(report.events, []);
  assert.ok(verifyReport(credential, "ANYTHING", report));
  reopened.close();
});
