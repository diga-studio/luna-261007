import assert from "node:assert/strict";
import { AlertEngine, WINDOW_MS } from "../src/engine";
import { AlertChange, Transaction } from "../src/types";

const H = WINDOW_MS;

function tx(
  id: string,
  terminal: string,
  timestamp: number,
  status: "failed" | "success"
): Transaction {
  return { transaction_id: id, terminal_id: terminal, timestamp, status };
}

type TestFn = () => void;
const tests: Array<[string, TestFn]> = [];
function test(name: string, fn: TestFn): void {
  tests.push([name, fn]);
}

test("alert starts when a failed transaction enters and ends when it leaves", () => {
  const engine = new AlertEngine(0);
  engine.ingest([tx("f1", "T1", 1000, "failed")]);
  const changes = engine.advanceWatermark(2000 + H);
  assert.deepEqual(changes, [
    { terminal_id: "T1", type: "start", timestamp: 1000 },
    { terminal_id: "T1", type: "end", timestamp: 1000 + H },
  ]);
});

test("exactly 5% never alerts; empty window never alerts", () => {
  const engine = new AlertEngine(0);
  const records: Transaction[] = [tx("f1", "T1", 5000, "failed")];
  for (let i = 0; i < 19; i++) {
    records.push(tx(`s${i}`, "T1", 5000, "success"));
  }
  engine.ingest(records);
  assert.deepEqual(engine.advanceWatermark(5000), []);
  assert.deepEqual(engine.advanceWatermark(5000 + H + 1), []);
});

test("un-ended interval reports only the start; end arrives on a later advance", () => {
  const engine = new AlertEngine(0);
  engine.ingest([tx("f1", "T1", 1000, "failed")]);
  assert.deepEqual(engine.advanceWatermark(5000), [
    { terminal_id: "T1", type: "start", timestamp: 1000 },
  ]);
  assert.deepEqual(engine.advanceWatermark(1000 + H), [
    { terminal_id: "T1", type: "end", timestamp: 1000 + H },
  ]);
  assert.deepEqual(engine.advanceWatermark(1000 + H), []);
});

test("one watermark jump over an interval raised and cleared purely by success expiry", () => {
  // 19 successes then 1 failed: 1/20 = exactly 5%, no alert.
  // When the oldest success expires, 1/19 > 5%: alert starts.
  // When the failed transaction expires, the window empties: alert ends.
  const engine = new AlertEngine(0);
  const records: Transaction[] = [tx("s0", "T1", 1000, "success")];
  for (let i = 1; i <= 18; i++) {
    records.push(tx(`s${i}`, "T1", 2000, "success"));
  }
  records.push(tx("f1", "T1", 3000, "failed"));
  engine.ingest(records);

  // A single huge jump; no new transactions exist after t=3000.
  const changes = engine.advanceWatermark(4000 + H);
  assert.deepEqual(changes, [
    { terminal_id: "T1", type: "start", timestamp: 1000 + H },
    { terminal_id: "T1", type: "end", timestamp: 3000 + H },
  ]);
});

test("same-millisecond enter and exit are atomic: no phantom alert", () => {
  // Window holds 1 failed + 19 successes (exactly 5%, not alerting).
  // At t=2H one success expires and one new success arrives; the state
  // before and after is exactly 5%, but processing records one by one
  // would transiently see 1/19 > 5%.
  const engine = new AlertEngine(0);
  const records: Transaction[] = [tx("s-old", "T1", H, "success")];
  for (let i = 0; i < 18; i++) {
    records.push(tx(`s${i}`, "T1", H + 1, "success"));
  }
  records.push(tx("f1", "T1", H + 2, "failed"));
  records.push(tx("s-new", "T1", 2 * H, "success"));
  engine.ingest(records);

  assert.deepEqual(engine.advanceWatermark(H + 2), []);
  const changes = engine.advanceWatermark(2 * H);
  assert.deepEqual(changes, []);
});

test("duplicate deliveries of the same transaction_id are counted once", () => {
  const engine = new AlertEngine(0);
  const record = tx("f1", "T1", 1000, "failed");
  engine.ingest([record, { ...record }]);
  engine.ingest([{ ...record }]);
  const changes = engine.advanceWatermark(2000);
  assert.deepEqual(changes, [
    { terminal_id: "T1", type: "start", timestamp: 1000 },
  ]);
});

test("records at or before the watermark are ignored", () => {
  const engine = new AlertEngine(1000);
  engine.ingest([
    tx("late", "T1", 1000, "failed"),
    tx("older", "T1", 500, "failed"),
  ]);
  assert.deepEqual(engine.advanceWatermark(5000), []);
});

test("watermark is monotonic", () => {
  const engine = new AlertEngine(1000);
  engine.advanceWatermark(2000);
  assert.throws(() => engine.advanceWatermark(1999));
  assert.deepEqual(engine.advanceWatermark(2000), []);
});

test("alert state is tracked per terminal", () => {
  const engine = new AlertEngine(0);
  engine.ingest([
    tx("f1", "A", 1000, "failed"),
    tx("s1", "B", 1000, "success"),
  ]);
  const changes = engine.advanceWatermark(2000);
  assert.deepEqual(changes, [
    { terminal_id: "A", type: "start", timestamp: 1000 },
  ]);
});

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("ingest permutation and advance step size never change the alert sequence", () => {
  const rand = mulberry32(42);
  const terminals = ["A", "B", "C"];
  const records: Transaction[] = [];
  for (let i = 0; i < 300; i++) {
    const terminal = terminals[Math.floor(rand() * terminals.length)]!;
    const timestamp = 1 + Math.floor(rand() * 2 * H);
    const status = rand() < 0.3 ? "failed" : "success";
    records.push(tx(`tx${i}`, terminal, timestamp, status));
  }
  // Duplicate some records; content is identical.
  for (let i = 0; i < 50; i++) {
    records.push({ ...records[Math.floor(rand() * 300)]! });
  }
  const finalWatermark = 4 * H;

  const run = (order: Transaction[], steps: number[]): AlertChange[] => {
    const engine = new AlertEngine(0);
    engine.ingest(order);
    const out: AlertChange[] = [];
    let at = 0;
    for (const step of steps) {
      at += step;
      out.push(...engine.advanceWatermark(Math.min(at, finalWatermark)));
    }
    if (at < finalWatermark) out.push(...engine.advanceWatermark(finalWatermark));
    return out;
  };

  const shuffled = [...records];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = shuffled[i]!;
    shuffled[i] = shuffled[j]!;
    shuffled[j] = tmp;
  }

  const baseline = run(records, [finalWatermark]);
  const manySteps = run(shuffled, Array.from({ length: 64 }, () => Math.ceil(finalWatermark / 64)));
  const unevenSteps = run(
    [...records].reverse(),
    [1, H / 3, 7, H, 123456789, H / 2, 5]
  );
  assert.deepEqual(manySteps, baseline);
  assert.deepEqual(unevenSteps, baseline);
  assert.ok(baseline.length > 0, "expected the random scenario to alert");
});

let failures = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL - ${name}`);
    console.error(err);
  }
}
if (failures > 0) {
  console.error(`${failures} of ${tests.length} tests failed`);
  process.exit(1);
}
console.log(`${tests.length} tests passed`);
