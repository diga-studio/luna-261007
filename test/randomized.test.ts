import test from "node:test";
import assert from "node:assert/strict";
import { WaitlistEngine } from "../src/index.ts";
import { ReferenceModel } from "./reference-model.ts";

/** 可复现的伪随机数发生器（mulberry32）。 */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickInt(rng: () => number, upperExclusive: number): number {
  return Math.floor(rng() * upperExclusive);
}

function pickTeam(
  rng: () => number,
  memberCount: number,
  maxSize: number,
): string[] {
  const size = 1 + pickInt(rng, maxSize);
  const team = new Set<string>();
  while (team.size < size) {
    team.add(`m${pickInt(rng, memberCount)}`);
  }
  return [...team];
}

interface CaseConfig {
  seed: number;
  trackCount: number;
  memberCount: number;
  maxTeamSize: number;
  ops: number;
  conflicts: ReadonlyArray<readonly [number, number]>;
  capacities: readonly number[];
}

function runCase(config: CaseConfig): void {
  const rng = makeRng(config.seed);
  const engine = new WaitlistEngine({
    capacities: config.capacities,
    conflicts: config.conflicts,
  });
  const reference = new ReferenceModel(config.capacities, config.conflicts);

  const liveIds: number[] = [];
  for (let op = 0; op < config.ops; op += 1) {
    const doWithdraw = liveIds.length > 0 && rng() < 0.35;
    if (doWithdraw) {
      const index = pickInt(rng, liveIds.length);
      const id = liveIds.splice(index, 1)[0] as number;
      engine.withdraw(id);
      reference.withdraw(id);
    } else {
      const trackId = pickInt(rng, config.trackCount);
      const team = pickTeam(rng, config.memberCount, config.maxTeamSize);
      const id = engine.register(trackId, team);
      const refId = reference.register(trackId, team);
      assert.equal(id, refId);
      liveIds.push(id);
    }

    const actual = engine.inspect();
    const expected = reference.inspect();
    assert.deepEqual(
      actual.registrations.map((r) => [r.id, r.seq, r.status]),
      expected.registrations.map((r) => [r.id, r.seq, r.status]),
      `registration states diverged at op ${op} (seed ${config.seed})`,
    );
    assert.deepEqual(
      actual.tracks.map((t) => t.occupied),
      expected.tracks.map((t) => t.occupied),
      `track occupancy diverged at op ${op} (seed ${config.seed})`,
    );
  }
}

test("随机对照：非传递冲突 + 多人重叠 + 撤回候补与已录取报名", () => {
  // A-B、B-C 冲突而 A-C 不冲突（非传递），成员池小以制造大量重叠。
  runCase({
    seed: 20261005,
    trackCount: 3,
    memberCount: 6,
    maxTeamSize: 4,
    ops: 1500,
    conflicts: [
      [0, 1],
      [1, 2],
    ],
    capacities: [3, 4, 3],
  });
});

test("随机对照：无冲突多赛道、容量紧张", () => {
  runCase({
    seed: 7,
    trackCount: 4,
    memberCount: 10,
    maxTeamSize: 5,
    ops: 1500,
    conflicts: [],
    capacities: [2, 3, 1, 4],
  });
});

test("随机对照：密集冲突图（含自冲突语义）", () => {
  runCase({
    seed: 424242,
    trackCount: 5,
    memberCount: 8,
    maxTeamSize: 3,
    ops: 2000,
    conflicts: [
      [0, 1],
      [0, 2],
      [1, 3],
      [2, 3],
      [2, 4],
      [3, 4],
    ],
    capacities: [2, 2, 3, 3, 2],
  });
});

test("随机对照：单人报名为主、长序列", () => {
  runCase({
    seed: 99,
    trackCount: 2,
    memberCount: 30,
    maxTeamSize: 1,
    ops: 3000,
    conflicts: [[0, 1]],
    capacities: [5, 5],
  });
});
