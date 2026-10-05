import { test } from "node:test";
import * as assert from "node:assert/strict";
import { createBaseline } from "../src/index";
import type { ProcessEvent } from "../src/types";

const HOUR = 3_600_000;
const T0 = 1_000_000;

test("learning period produces no verdicts", () => {
  const lib = createBaseline();
  lib.openWorkload("w", T0);
  const verdicts = lib.ingest("w", [
    { t: T0, pid: 1, type: "start" },
    { t: T0 + 1, pid: 1, type: "call", call: 1 },
    { t: T0 + HOUR - 1, pid: 1, type: "call", call: 2 },
    { t: T0 + HOUR - 1, pid: 1, type: "exit" },
  ]);
  assert.deepEqual(verdicts, []);
});

test("process alive across the boundary keeps its call context", () => {
  const lib = createBaseline();
  lib.openWorkload("w", T0);
  // instance starts during learning and survives past the boundary
  lib.ingest("w", [
    { t: T0 + HOUR - 3, pid: 1, type: "start" },
    { t: T0 + HOUR - 2, pid: 1, type: "call", call: 5 },
    { t: T0 + HOUR - 1, pid: 1, type: "call", call: 6 },
    { t: T0 + HOUR - 1, pid: 1, type: "call", call: 7 },
  ]);
  // detection: the instance repeats its learned pattern 5,6,7.
  // k keeps counting the pre-boundary calls (context is not cleared at
  // the boundary) and m grows as the replayed suffix re-matches the
  // learned 5,6,7 substring.
  const verdicts = lib.ingest("w", [
    { t: T0 + HOUR, pid: 1, type: "call", call: 5 },
    { t: T0 + HOUR + 1, pid: 1, type: "call", call: 6 },
    { t: T0 + HOUR + 2, pid: 1, type: "call", call: 7 },
  ]);
  assert.deepEqual(
    verdicts.map((v) => [v.k, v.m, v.anomalous]),
    [
      [4, 1, true], // seq 5,6,7,5: longest known suffix is "5"
      [5, 2, true], // seq 5,6,7,5,6: longest known suffix is "5,6"
      [6, 3, true], // seq 5,6,7,5,6,7: longest known suffix is "5,6,7"
    ],
  );
});

test("call exactly at t0+3600000 belongs to detection, not learning", () => {
  const lib = createBaseline();
  lib.openWorkload("w", T0);
  lib.ingest("w", [
    { t: T0, pid: 1, type: "start" },
    { t: T0 + HOUR - 1, pid: 1, type: "call", call: 1 },
    { t: T0 + HOUR - 1, pid: 1, type: "exit" },
  ]);
  // boundary call: must yield a verdict and must NOT be learned
  const atBoundary = lib.ingest("w", [
    { t: T0 + HOUR, pid: 2, type: "start" },
    { t: T0 + HOUR, pid: 2, type: "call", call: 3 },
    { t: T0 + HOUR, pid: 2, type: "exit" },
  ]);
  assert.equal(atBoundary.length, 1);
  assert.deepEqual([atBoundary[0]!.m, atBoundary[0]!.anomalous], [0, true]);
  // if "3" had been learned, this later instance would see m=1
  const later = lib.ingest("w", [
    { t: T0 + HOUR + 10, pid: 3, type: "start" },
    { t: T0 + HOUR + 11, pid: 3, type: "call", call: 3 },
  ]);
  assert.deepEqual([later[0]!.m, later[0]!.anomalous], [0, true]);
  // sanity: a call one ms before the boundary IS learned
  const lib2 = createBaseline();
  lib2.openWorkload("w", T0);
  lib2.ingest("w", [
    { t: T0, pid: 1, type: "start" },
    { t: T0 + HOUR - 1, pid: 1, type: "call", call: 9 },
    { t: T0 + HOUR - 1, pid: 1, type: "exit" },
  ]);
  const v = lib2.ingest("w", [
    { t: T0 + HOUR, pid: 2, type: "start" },
    { t: T0 + HOUR + 1, pid: 2, type: "call", call: 9 },
  ]);
  assert.deepEqual([v[0]!.m, v[0]!.anomalous], [1, false]);
});

test("repeated novel combination in detection never becomes normal", () => {
  const lib = createBaseline();
  lib.openWorkload("w", T0);
  lib.ingest("w", [
    { t: T0, pid: 1, type: "start" },
    { t: T0 + 1, pid: 1, type: "call", call: 1 },
    { t: T0 + 2, pid: 1, type: "call", call: 2 },
    { t: T0 + 3, pid: 1, type: "exit" },
  ]);
  const round = (t: number, pid: number): ProcessEvent[] => [
    { t, pid, type: "start" },
    { t: t + 1, pid, type: "call", call: 4 },
    { t: t + 2, pid, type: "call", call: 5 },
    { t: t + 3, pid, type: "exit" },
  ];
  // same陌生 combination 4,5 appears three times, even reusing the pid
  const first = lib.ingest("w", round(T0 + HOUR, 7));
  const second = lib.ingest("w", round(T0 + HOUR + 100, 8));
  const third = lib.ingest("w", round(T0 + HOUR + 200, 7));
  const expected = [
    [1, 0, true], // k=1, "4" unseen
    [2, 0, true], // k=2, "4,5" unseen
  ];
  for (const v of [first, second, third]) {
    assert.deepEqual(
      v.map((x) => [x.k, x.m, x.anomalous]),
      expected,
    );
  }
});
