import test from "node:test";
import assert from "node:assert/strict";
import { AlertChange, Transaction, VaultPayAlertEngine, WINDOW_MS } from "../src/index";

const H = WINDOW_MS;

function tx(
  id: string,
  terminal: string,
  timestamp: number,
  status: string,
): Transaction {
  return { transaction_id: id, terminal_id: terminal, timestamp, status };
}

function failed(id: string, terminal: string, timestamp: number): Transaction {
  return tx(id, terminal, timestamp, "failed");
}

function success(id: string, terminal: string, timestamp: number): Transaction {
  return tx(id, terminal, timestamp, "success");
}

test("场景A: 一次水位跳跃跨过仅由成功交易过期触发、随后又结束的超阈区间", () => {
  // 19 成功 @1000 + 1 失败 @2000：窗口内 1/20 = 恰好 5%，不超阈。
  // t = 1000+H 时 19 条成功整体过期 -> 1/1 = 100% 超阈（告警开始）。
  // t = 2000+H 时失败也过期 -> 空窗口不超阈（告警结束）。
  const engine = new VaultPayAlertEngine(2000);
  const records: Transaction[] = [];
  for (let i = 0; i < 19; i++) records.push(success(`s${i}`, "T1", 1000));
  records.push(failed("f0", "T1", 2000));
  engine.ingest(records);

  // 一次大跳跃，跨过整个区间，中途没有新交易也不能漏报。
  const changes = engine.advanceWatermark(2000 + H + 5000);
  assert.deepEqual(changes, [
    { terminal_id: "T1", type: "start", timestamp: 1000 + H },
    { terminal_id: "T1", type: "end", timestamp: 2000 + H },
  ]);
});

test("场景B: 同毫秒的新交易和过期整体生效，不产生虚假超阈", () => {
  // 窗口在 t = 1000+H 之前: 1 失败 + 19 成功 = 恰好 5%，不超阈。
  // t = 1000+H 时：1 条成功过期（若先处理会暂时变成 1/19 > 5%），
  // 同时 1 条新成功进入，整体生效后仍是 1/20 = 5%，不超阈。
  const engine = new VaultPayAlertEngine(3000);
  engine.ingest([
    failed("f0", "T1", 2000),
    success("old", "T1", 1000), // 于 1000+H 过期
    ...Array.from({ length: 18 }, (_, i) => success(`s${i}`, "T1", 3000)),
    success("new", "T1", 1000 + H), // 于 1000+H 进入窗口（水位之后的交易暂存）
  ]);

  const changes = engine.advanceWatermark(1000 + H + 1000);
  assert.deepEqual(changes, []);
});

test("基本超阈：未结束区间只返回开始，结束后返回结束", () => {
  const engine = new VaultPayAlertEngine(0);
  engine.ingest([failed("f0", "T1", 5000)]);

  // 水位未到交易时间：水位之后的交易暂不影响当前窗口。
  assert.deepEqual(engine.advanceWatermark(4000), []);
  // 进入窗口：1/1 = 100% 超阈，只返回开始。
  assert.deepEqual(engine.advanceWatermark(5000), [
    { terminal_id: "T1", type: "start", timestamp: 5000 },
  ]);
  // 区间未结束：中间推进不重复报告。
  assert.deepEqual(engine.advanceWatermark(5000 + H - 1), []);
  // 失败交易过期：窗口变空，返回结束。
  assert.deepEqual(engine.advanceWatermark(5000 + H + 1), [
    { terminal_id: "T1", type: "end", timestamp: 5000 + H },
  ]);
});

test("恰好 5% 不超阈，空窗口不超阈", () => {
  const engine = new VaultPayAlertEngine(0);
  const records: Transaction[] = [failed("f0", "T1", 1000)];
  for (let i = 0; i < 19; i++) records.push(success(`s${i}`, "T1", 1000));
  engine.ingest(records);
  // 1/20 = 5% 恰好不超阈；全部过期后空窗口也不超阈。
  assert.deepEqual(engine.advanceWatermark(1000 + H + 1000), []);

  const empty = new VaultPayAlertEngine(0);
  assert.deepEqual(empty.advanceWatermark(H * 7), []);
});

test("同一 transaction_id 重复投递不增加计数", () => {
  const engine = new VaultPayAlertEngine(0);
  const dup = failed("f0", "T1", 1000);
  const records: Transaction[] = [dup, { ...dup }, dup];
  for (let i = 0; i < 19; i++) records.push(success(`s${i}`, "T1", 1000));
  engine.ingest(records);
  // 跨批次重复投递同样去重。
  engine.ingest([dup]);
  // 若重复计数则为 2/22 > 5% 会误报；去重后 1/20 = 5% 不超阈。
  assert.deepEqual(engine.advanceWatermark(1000 + H + 1000), []);
});

test("输入排列与推进步长不影响拼接后的告警序列", () => {
  const records: Transaction[] = [
    // T1: 仅由成功过期触发、随后结束的区间（同场景A）。
    ...Array.from({ length: 19 }, (_, i) => success(`a-s${i}`, "A", 1000)),
    failed("a-f0", "A", 2000),
    // T2: 单条失败，进入即超阈，过期即结束。
    failed("b-f0", "B", 5000),
    // T3: 失败先到 -> 超阈；成功到达降为 5% 结束；第二条失败再到 -> 超阈；
    // 第一条失败过期降为 5% 结束；成功过期 -> 超阈；第二条失败过期 -> 结束。
    failed("c-f0", "C", 3000),
    failed("c-f1", "C", 4000),
    ...Array.from({ length: 19 }, (_, i) => success(`c-s${i}`, "C", 3500)),
  ];

  const expected: AlertChange[] = ([
    { terminal_id: "C", type: "start", timestamp: 3000 },
    { terminal_id: "C", type: "end", timestamp: 3500 },
    { terminal_id: "C", type: "start", timestamp: 4000 },
    { terminal_id: "B", type: "start", timestamp: 5000 },
    { terminal_id: "A", type: "start", timestamp: 1000 + H },
    { terminal_id: "A", type: "end", timestamp: 2000 + H },
    { terminal_id: "C", type: "end", timestamp: 3000 + H },
    { terminal_id: "C", type: "start", timestamp: 3500 + H },
    { terminal_id: "C", type: "end", timestamp: 4000 + H },
    { terminal_id: "B", type: "end", timestamp: 5000 + H },
  ] as AlertChange[]).sort((a, b) =>
    a.timestamp !== b.timestamp
      ? a.timestamp - b.timestamp
      : a.terminal_id.localeCompare(b.terminal_id),
  );

  // 引擎1：一次 ingest、一次大跳跃。
  const e1 = new VaultPayAlertEngine(0);
  e1.ingest(records);
  const out1 = e1.advanceWatermark(5000 + H + 1);

  // 引擎2：乱序 + 重复 + 分批 ingest，小步推进。
  const e2 = new VaultPayAlertEngine(0);
  const shuffled = [...records].reverse();
  e2.ingest(shuffled.slice(10));
  e2.ingest(shuffled.slice(0, 10));
  e2.ingest([records[0]!, records[5]!]); // 重复投递
  const out2: AlertChange[] = [];
  for (let t = 1000; t <= 5000 + H + 1; t += 997) {
    out2.push(...e2.advanceWatermark(t));
  }
  out2.push(...e2.advanceWatermark(5000 + H + 1));

  // 引擎3：又一种分批与步长。
  const e3 = new VaultPayAlertEngine(0);
  for (const r of records) e3.ingest([r]);
  const out3: AlertChange[] = [];
  out3.push(...e3.advanceWatermark(4000));
  out3.push(...e3.advanceWatermark(4000)); // 不推进：无变化
  out3.push(...e3.advanceWatermark(1000 + H));
  out3.push(...e3.advanceWatermark(5000 + H + 1));

  assert.deepEqual(out1, expected);
  assert.deepEqual(out2, expected);
  assert.deepEqual(out3, expected);
});

test("水位单调：回退抛错，原地推进返回空", () => {
  const engine = new VaultPayAlertEngine(100);
  engine.advanceWatermark(200);
  assert.throws(() => engine.advanceWatermark(199), /watermark/);
  assert.deepEqual(engine.advanceWatermark(200), []);
});

test("多终端同毫秒变化：按 (时刻, 终端) 确定排序，无零长度告警", () => {
  const engine = new VaultPayAlertEngine(0);
  engine.ingest([failed("f1", "T2", 7000), failed("f2", "T1", 7000)]);
  const changes = engine.advanceWatermark(7000 + H);
  assert.deepEqual(changes, [
    { terminal_id: "T1", type: "start", timestamp: 7000 },
    { terminal_id: "T2", type: "start", timestamp: 7000 },
    { terminal_id: "T1", type: "end", timestamp: 7000 + H },
    { terminal_id: "T2", type: "end", timestamp: 7000 + H },
  ]);
  // 同一终端不会在相邻变化中出现 start 与 end 时刻相同（零长度告警）。
  for (const terminal of ["T1", "T2"]) {
    const mine = changes.filter((c) => c.terminal_id === terminal);
    for (let i = 1; i < mine.length; i++) {
      assert.notEqual(mine[i]!.timestamp, mine[i - 1]!.timestamp);
    }
  }
});
