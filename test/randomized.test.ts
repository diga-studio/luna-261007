import { test } from "node:test";
import * as assert from "node:assert/strict";
import { createBaseline } from "../src/index";
import type { CallVerdict, ProcessEvent } from "../src/types";
import { ReferenceBaseline } from "./reference";

const HOUR = 3_600_000;

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

interface WorkloadScript {
  id: string;
  t0: number;
  batches: ProcessEvent[][];
}

/**
 * Generates a random workload script: multiple processes with interleaved
 * events, pid reuse after exit, and a timeline spanning the learning
 * boundary. Events are non-decreasing in time as required.
 */
function generateWorkload(
  id: string,
  t0: number,
  rand: () => number,
  pids: number[],
  callPool: number[],
): WorkloadScript {
  const active = new Set<number>();
  const events: ProcessEvent[] = [];
  let t = t0;
  const span = HOUR * 2; // comfortably crosses the boundary
  while (t < t0 + span) {
    t += Math.floor(rand() * (HOUR / 20)); // ~3min average step
    const idle = pids.filter((p) => !active.has(p));
    const busy = pids.filter((p) => active.has(p));
    const roll = rand();
    if (busy.length > 0 && (roll < 0.65 || idle.length === 0)) {
      const pid = busy[Math.floor(rand() * busy.length)]!;
      events.push({ t, pid, type: "call", call: callPool[Math.floor(rand() * callPool.length)] });
    } else if (busy.length > 0 && roll < 0.8) {
      const pid = busy[Math.floor(rand() * busy.length)]!;
      events.push({ t, pid, type: "exit" });
      active.delete(pid);
    } else {
      const pid = idle[Math.floor(rand() * idle.length)]!;
      events.push({ t, pid, type: "start" });
      active.add(pid);
    }
  }
  // split into random ingest batches
  const batches: ProcessEvent[][] = [];
  let i = 0;
  while (i < events.length) {
    const n = 1 + Math.floor(rand() * 7);
    batches.push(events.slice(i, i + n));
    i += n;
  }
  return { id, t0, batches };
}

function runAll(
  lib: { openWorkload(id: string, t0: number): void; ingest(id: string, ev: readonly ProcessEvent[]): CallVerdict[] },
  scripts: WorkloadScript[],
): CallVerdict[] {
  const out: CallVerdict[] = [];
  for (const s of scripts) {
    lib.openWorkload(s.id, s.t0);
    for (const batch of s.batches) {
      out.push(...lib.ingest(s.id, batch));
    }
  }
  return out;
}

test("randomized cross-check against brute-force reference", () => {
  for (let seed = 1; seed <= 25; seed++) {
    const rand = mulberry32(seed);
    // same pids reused across workloads on purpose: workloads must stay isolated
    const pids = [11, 22, 33, 44];
    const scripts = [
      generateWorkload("w1", 1_000_000, rand, pids, [1, 2, 3, 4]),
      generateWorkload("w2", 5_000_000, rand, pids, [1, 2, 3, 4]),
      generateWorkload("w3", 9_000_000, rand, pids, [2, 3, 5, 7]),
    ];
    const expected = runAll(new ReferenceBaseline(), scripts);
    const actual = runAll(createBaseline(), scripts);
    assert.equal(actual.length, expected.length, `seed ${seed}: verdict count`);
    for (let i = 0; i < expected.length; i++) {
      assert.deepEqual(actual[i], expected[i], `seed ${seed}: verdict #${i}`);
    }
    assert.ok(expected.length > 0, `seed ${seed}: script should produce detection calls`);
  }
});

test("pseudo-normal combinations from concatenating independent sequences", () => {
  // learning: process A learns [1,2], process B learns [3,4] (same workload).
  // detection: a process emits [1,2,3,4]. The full sequence never appeared;
  // only a broken implementation that concatenates independent sequences
  // would call it normal. Longest matching suffix is [3,4] => m = 2.
  const t0 = 0;
  const lib = createBaseline();
  lib.openWorkload("w", t0);
  lib.ingest("w", [
    { t: 0, pid: 1, type: "start" },
    { t: 1, pid: 1, type: "call", call: 1 },
    { t: 2, pid: 1, type: "call", call: 2 },
    { t: 3, pid: 1, type: "exit" },
    { t: 4, pid: 2, type: "start" },
    { t: 5, pid: 2, type: "call", call: 3 },
    { t: 6, pid: 2, type: "call", call: 4 },
    { t: 7, pid: 2, type: "exit" },
  ]);
  const verdicts = lib.ingest("w", [
    { t: HOUR, pid: 9, type: "start" },
    { t: HOUR + 1, pid: 9, type: "call", call: 1 },
    { t: HOUR + 2, pid: 9, type: "call", call: 2 },
    { t: HOUR + 3, pid: 9, type: "call", call: 3 },
    { t: HOUR + 4, pid: 9, type: "call", call: 4 },
  ]);
  assert.deepEqual(
    verdicts.map((v) => [v.m, v.anomalous]),
    [
      [1, false], // "1" is a known substring and min(k,8)=1
      [2, false], // "1,2" learned by process A
      [1, true], // "2,3" never seen; only "3" matches; min(k,8)=3
      [2, true], // "3,4" learned by process B, but min(k,8)=4
    ],
  );
});

test("sequences are not normal just because another workload learned them", () => {
  const lib = createBaseline();
  lib.openWorkload("a", 0);
  lib.openWorkload("b", 0);
  lib.ingest("a", [
    { t: 0, pid: 1, type: "start" },
    { t: 1, pid: 1, type: "call", call: 7 },
    { t: 2, pid: 1, type: "call", call: 8 },
    { t: 3, pid: 1, type: "call", call: 9 },
  ]);
  const verdicts = lib.ingest("b", [
    { t: HOUR, pid: 1, type: "start" },
    { t: HOUR + 1, pid: 1, type: "call", call: 7 },
    { t: HOUR + 2, pid: 1, type: "call", call: 8 },
    { t: HOUR + 3, pid: 1, type: "call", call: 9 },
  ]);
  assert.deepEqual(
    verdicts.map((v) => [v.m, v.anomalous]),
    [
      [0, true],
      [0, true],
      [0, true],
    ],
  );
});
