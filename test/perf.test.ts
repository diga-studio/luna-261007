import { test } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { Ledger } from "../src/index.js";
import type { EventInput } from "../src/index.js";
import { tempDbPath } from "./helpers.js";

const TOTAL_EVENTS = 1_000_000;
const TOTAL_RECORDS = 100_000;
const TARGET_RECORD = "rec-target";
const TARGET_EVENTS = 100;
const BODY_128 = "x".repeat(128);

const TIME_LIMIT_MS = 2_000;
const MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
const PROOF_LIMIT_BYTES = 64 * 1024;

interface ChildMetrics {
  elapsedMs: number;
  rssDeltaBytes: number;
  proofBytes: number;
  verified: boolean;
}

function buildLargeLedger(): { path: string; credential: Uint8Array } {
  const path = tempDbPath("perf.db");
  const ledger = Ledger.open(path);

  const batch: EventInput[] = [];
  let targetRemaining = TARGET_EVENTS;
  const baseTs = 1_700_000_000;
  for (let i = 0; i < TOTAL_EVENTS; i++) {
    // 每 997 个事件安插一条目标记录事件，保证目标记录恰好 100 条且分散。
    const isTarget = targetRemaining > 0 && i % 997 === 0;
    if (isTarget) targetRemaining -= 1;
    const recordId = isTarget ? TARGET_RECORD : `rec-${i % (TOTAL_RECORDS - 1)}`;
    batch.push({
      recordId,
      timestamp: baseTs + (i % 500), // 大量同秒事件
      operator: `operator-${i % 100}`,
      body: isTarget ? BODY_128 : `body-${i}`,
    });
    if (batch.length === 50_000) {
      ledger.appendEvents(batch);
      batch.length = 0;
    }
  }
  if (batch.length > 0) ledger.appendEvents(batch);

  const credential = ledger.seal();
  ledger.close();
  return { path, credential };
}

function measureReport(path: string, recordId: string, credential: Uint8Array): ChildMetrics {
  const childScript = join(__dirname, "perf-child.js");
  const result = spawnSync(
    process.argv[0]!,
    [childScript, path, recordId, Buffer.from(credential).toString("hex")],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`perf child failed: ${result.stderr.toString()}`);
  }
  const line = result.stdout.toString().trim().split("\n").pop()!;
  return JSON.parse(line) as ChildMetrics;
}

test(
  "100 万事件 / 10 万记录：重开后生成报告的耗时、内存与校验材料大小",
  { timeout: 600_000 },
  () => {
    const { path, credential } = buildLargeLedger();

    // 场景一：目标记录有 100 条事件（每条正文 128 字节）。
    const nonEmpty = measureReport(path, TARGET_RECORD, credential);
    assert.ok(nonEmpty.verified, "non-empty report must verify");
    assert.ok(
      nonEmpty.elapsedMs <= TIME_LIMIT_MS,
      `non-empty report took ${nonEmpty.elapsedMs.toFixed(0)}ms (> ${TIME_LIMIT_MS}ms)`,
    );
    assert.ok(
      nonEmpty.rssDeltaBytes <= MEMORY_LIMIT_BYTES,
      `non-empty report peak extra memory ${(nonEmpty.rssDeltaBytes / 1048576).toFixed(1)}MiB (> 64MiB)`,
    );
    assert.ok(
      nonEmpty.proofBytes <= PROOF_LIMIT_BYTES,
      `non-empty proof ${nonEmpty.proofBytes} bytes (> 64KiB)`,
    );

    // 场景二：不存在的记录，空报告。
    const empty = measureReport(path, "rec-no-such-record", credential);
    assert.ok(empty.verified, "empty report must verify");
    assert.ok(
      empty.elapsedMs <= TIME_LIMIT_MS,
      `empty report took ${empty.elapsedMs.toFixed(0)}ms (> ${TIME_LIMIT_MS}ms)`,
    );
    assert.ok(
      empty.rssDeltaBytes <= MEMORY_LIMIT_BYTES,
      `empty report peak extra memory ${(empty.rssDeltaBytes / 1048576).toFixed(1)}MiB (> 64MiB)`,
    );
    assert.ok(
      empty.proofBytes <= PROOF_LIMIT_BYTES,
      `empty proof ${empty.proofBytes} bytes (> 64KiB)`,
    );

    console.log(
      `non-empty: ${nonEmpty.elapsedMs.toFixed(0)}ms, ` +
        `+${(nonEmpty.rssDeltaBytes / 1048576).toFixed(1)}MiB, proof ${nonEmpty.proofBytes}B`,
    );
    console.log(
      `empty: ${empty.elapsedMs.toFixed(0)}ms, ` +
        `+${(empty.rssDeltaBytes / 1048576).toFixed(1)}MiB, proof ${empty.proofBytes}B`,
    );
  },
);
