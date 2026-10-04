import { test } from "node:test";
import assert from "node:assert/strict";
import { createSession } from "../src/index.ts";
import type { RepresentativeInput, SampleInput } from "../src/index.ts";
import {
  bruteForceRecommend,
  mulberry32,
  randomRepresentatives,
  randomSamples,
} from "./helpers.ts";

const Z = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
function vec(first: number): number[] {
  return [first, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
}

test("hand-computed example: greedy re-evaluates gains after each pick", () => {
  // 代表点 R1@[0] 权重 1，R2@[100] 权重 10；候选 A@[0] B@[100] C@[50]。
  // 若只在批次开始排一次序，顺序是 B(11434400) C(11416900) A(11344400)；
  // 正确的逐步贪心在选中 B 后重算，A(10000) 优于 C(7500)，顺序应为 B A C。
  const samples: SampleInput[] = [
    { id: 5, features: vec(0) },
    { id: 3, features: vec(100) },
    { id: 7, features: vec(50) },
  ];
  const representatives: RepresentativeInput[] = [
    { features: vec(0), weight: 1 },
    { features: vec(100), weight: 10 },
  ];
  const session = createSession({ samples, representatives });
  assert.deepEqual(session.recommend(3), [3, 5, 7]);
  assert.deepEqual(bruteForceRecommend(samples, representatives, new Set(), 3), [3, 5, 7]);
});

test("random small pools match brute force (with pre-labeled sets)", () => {
  for (let seed = 1; seed <= 12; seed++) {
    const rand = mulberry32(seed);
    const samples = randomSamples(30, rand);
    const representatives = randomRepresentatives(8, rand);
    const labeledIds = new Set<number>();
    const labeledCount = Math.floor(rand() * 6);
    for (let i = 0; i < labeledCount; i++) {
      labeledIds.add(samples[Math.floor(rand() * samples.length)]!.id);
    }
    const count = 1 + Math.floor(rand() * 12);
    const session = createSession({ samples, representatives, labeledIds: [...labeledIds] });
    const expected = bruteForceRecommend(samples, representatives, labeledIds, count);
    assert.deepEqual(session.recommend(count), expected, `seed=${seed} count=${count}`);
  }
});

test("high-weight representatives (weight 10000, extreme features)", () => {
  const rand = mulberry32(99);
  const samples = randomSamples(25, rand);
  const representatives: RepresentativeInput[] = [
    { features: new Array(16).fill(0), weight: 10_000 },
    { features: new Array(16).fill(255), weight: 10_000 },
    { features: randomSamples(1, rand)[0]!.features, weight: 9_999 },
  ];
  const session = createSession({ samples, representatives });
  const expected = bruteForceRecommend(samples, representatives, new Set(), 10);
  assert.deepEqual(session.recommend(10), expected);
});

test("identical features with different ids: ties broken by smaller id", () => {
  const shared = vec(200);
  const samples: SampleInput[] = [
    { id: 10, features: shared },
    { id: 4, features: [...shared] },
    { id: 7, features: [...shared] },
    { id: 1, features: vec(0) },
  ];
  const representatives: RepresentativeInput[] = [{ features: vec(100), weight: 5 }];
  const session = createSession({ samples, representatives });
  // id=1 的样本收益不同（距离代表点更远，收益更大），先被选中；
  // 其余三条特征相同、收益相同，按 ID 升序 4, 7, 10。
  const result = session.recommend(4);
  assert.deepEqual(result, bruteForceRecommend(samples, representatives, new Set(), 4));
  assert.deepEqual(result, [1, 4, 7, 10]);
});

test("zero-gain ties still fill the batch by ascending id", () => {
  // 已标注样本与唯一代表点特征相同，所有候选收益均为 0。
  const samples: SampleInput[] = [
    { id: 9, features: vec(50) },
    { id: 2, features: vec(60) },
    { id: 5, features: vec(70) },
    { id: 0, features: vec(10) },
  ];
  const representatives: RepresentativeInput[] = [{ features: vec(10), weight: 3 }];
  const session = createSession({ samples, representatives, labeledIds: [0] });
  assert.deepEqual(session.recommend(3), [2, 5, 9]);
  // 请求数量超过剩余未标注数量时返回全部剩余样本。
  assert.deepEqual(session.recommend(4), [2, 5, 9]);
});

test("labeling only part of a batch matches a fresh session with the same labeled set", () => {
  const rand = mulberry32(7);
  const samples = randomSamples(40, rand);
  const representatives = randomRepresentatives(10, rand);
  const initial = [samples[0]!.id, samples[5]!.id];

  const sessionA = createSession({ samples, representatives, labeledIds: initial });
  const batch = sessionA.recommend(10);
  const actuallyLabeled = batch.slice(0, 4);
  sessionA.markLabeled(actuallyLabeled);
  const secondA = sessionA.recommend(6);

  const sessionB = createSession({
    samples,
    representatives,
    labeledIds: [...initial, ...actuallyLabeled],
  });
  assert.deepEqual(secondA, sessionB.recommend(6));
});

test("recommend is deterministic and does not change state", () => {
  const rand = mulberry32(21);
  const samples = randomSamples(30, rand);
  const representatives = randomRepresentatives(8, rand);
  const session = createSession({ samples, representatives, labeledIds: [samples[1]!.id] });
  const before = session.remainingCount;
  const first = session.recommend(8);
  const second = session.recommend(8);
  assert.deepEqual(first, second);
  assert.equal(session.remainingCount, before);
  assert.equal(session.labeledCount, 1);
});

test("shorter result is a prefix of a longer one", () => {
  const rand = mulberry32(33);
  const samples = randomSamples(40, rand);
  const representatives = randomRepresentatives(10, rand);
  const session = createSession({ samples, representatives });
  const short = session.recommend(4);
  const long = session.recommend(11);
  assert.deepEqual(long.slice(0, short.length), short);
});

test("no duplicate ids within a batch and labeled samples excluded", () => {
  const rand = mulberry32(45);
  const samples = randomSamples(30, rand);
  const representatives = randomRepresentatives(6, rand);
  const labeledIds = [samples[2]!.id, samples[8]!.id];
  const session = createSession({ samples, representatives, labeledIds });
  const batch = session.recommend(20);
  assert.equal(new Set(batch).size, batch.length);
  for (const id of labeledIds) {
    assert.ok(!batch.includes(id));
  }
});

test("input validation", () => {
  const samples = randomSamples(5, mulberry32(1));
  const representatives = randomRepresentatives(2, mulberry32(2));
  const session = createSession({ samples, representatives });

  assert.throws(() => session.recommend(0), RangeError);
  assert.throws(() => session.recommend(201), RangeError);
  assert.throws(() => session.recommend(1.5), RangeError);
  assert.throws(() => session.markLabeled([12345]), TypeError);

  assert.throws(
    () => createSession({ samples: [...samples, samples[0]!], representatives }),
    TypeError,
  );
  assert.throws(
    () => createSession({ samples, representatives, labeledIds: [999] }),
    TypeError,
  );
  assert.throws(
    () =>
      createSession({
        samples: [{ id: 1, features: [1, 2, 3] }],
        representatives,
      }),
    TypeError,
  );
  assert.throws(
    () =>
      createSession({
        samples,
        representatives: [{ features: Z, weight: 0 }],
      }),
    TypeError,
  );
  assert.throws(
    () =>
      createSession({
        samples,
        representatives: [{ features: Z, weight: 10_001 }],
      }),
    TypeError,
  );

  // 重复标记同一样本是幂等操作。
  session.markLabeled([samples[0]!.id]);
  session.markLabeled([samples[0]!.id]);
  assert.equal(session.labeledCount, 1);
});
