import { test } from "node:test";
import assert from "node:assert/strict";
import lib from "../dist/index.js";
import {
  makeRng,
  randomPool,
  randomReps,
  randomFeatures,
  bruteForceRecommend,
  FEATURE_DIM,
} from "./helpers.mjs";

const { DiversitySession, EMPTY_COVER_COST, MAX_BATCH } = lib;

test("constant exports", () => {
  assert.equal(EMPTY_COVER_COST, 16 * 255 * 255);
  assert.equal(MAX_BATCH, 200);
  assert.equal(FEATURE_DIM, 16);
});

test("matches brute force on randomized small cases", () => {
  for (let seed = 1; seed <= 30; seed++) {
    const rng = makeRng(seed);
    const n = 3 + Math.floor(rng() * 25);
    const m = 1 + Math.floor(rng() * 12);
    const samples = randomPool(rng, n);
    const reps = randomReps(rng, m);
    const labeled = new Set();
    for (const s of samples) if (rng() < 0.3) labeled.add(s.id);
    const k = 1 + Math.floor(rng() * Math.min(n, 10));
    const session = new DiversitySession({ samples, representatives: reps, labeledIds: labeled });
    const expected = bruteForceRecommend(samples, reps, labeled, k);
    assert.deepEqual(session.recommend(k), expected, `seed=${seed} n=${n} m=${m} k=${k}`);
  }
});

test("matches brute force with duplicate features and heavy weights", () => {
  for (let seed = 100; seed < 115; seed++) {
    const rng = makeRng(seed);
    const shared = randomFeatures(rng);
    // many samples share identical features; different ids
    const samples = [];
    for (let i = 0; i < 12; i++) {
      samples.push({ id: 100 + i, features: rng() < 0.6 ? [...shared] : randomFeatures(rng) });
    }
    const reps = randomReps(rng, 6, { weightMax: 10000 });
    reps.push({ features: [...shared], weight: 10000 });
    const labeled = new Set(rng() < 0.5 ? [105] : []);
    const k = 5;
    const session = new DiversitySession({ samples, representatives: reps, labeledIds: labeled });
    const expected = bruteForceRecommend(samples, reps, labeled, k);
    assert.deepEqual(session.recommend(k), expected, `seed=${seed}`);
  }
});

test("zero-gain ties: selects smallest ids, fills the batch", () => {
  const f = randomFeatures(makeRng(7));
  // a labeled sample identical to every candidate => all gains are zero
  const samples = [
    { id: 50, features: [...f] },
    { id: 9, features: [...f] },
    { id: 30, features: [...f] },
    { id: 12, features: [...f] },
    { id: 77, features: [...f] },
  ];
  const reps = [{ features: randomFeatures(makeRng(8)), weight: 500 }];
  const session = new DiversitySession({ samples, representatives: reps, labeledIds: [50] });
  assert.deepEqual(session.recommend(3), [9, 12, 30]);
  // remaining unlabeled are returned when pool is smaller than the request
  assert.deepEqual(session.recommend(200), [9, 12, 30, 77]);
});

test("high-weight representative dominates the choice", () => {
  // rep A (weight 10000) near sample 1; rep B (weight 1) near sample 2
  const near = (base, delta) => base.map((v, i) => Math.min(255, v + ((i + delta) % 3)));
  const base = randomFeatures(makeRng(11));
  const samples = [
    { id: 1, features: near(base, 0) },
    { id: 2, features: base.map((v) => 255 - v) },
  ];
  const reps = [
    { features: [...base], weight: 10000 },
    { features: base.map((v) => 255 - v), weight: 1 },
  ];
  const session = new DiversitySession({ samples, representatives: reps });
  assert.deepEqual(session.recommend(1), [1]);
});

test("recommend does not mutate state; repeat calls are identical", () => {
  const rng = makeRng(42);
  const samples = randomPool(rng, 40);
  const reps = randomReps(rng, 10);
  const session = new DiversitySession({ samples, representatives: reps, labeledIds: [samples[0].id] });
  const first = session.recommend(8);
  const second = session.recommend(8);
  assert.deepEqual(first, second);
  assert.equal(session.labeledCount, 1);
});

test("prefix property: shorter request is a prefix of longer one", () => {
  const rng = makeRng(43);
  const samples = randomPool(rng, 60);
  const reps = randomReps(rng, 15);
  const session = new DiversitySession({ samples, representatives: reps });
  const short = session.recommend(5);
  const long = session.recommend(20);
  assert.deepEqual(long.slice(0, short.length), short);
});

test("labeling only part of a recommendation equals a fresh session", () => {
  const rng = makeRng(44);
  const samples = randomPool(rng, 50);
  const reps = randomReps(rng, 12);
  const initialLabeled = new Set([samples[3].id, samples[7].id]);

  const sessionA = new DiversitySession({ samples, representatives: reps, labeledIds: initialLabeled });
  const batch = sessionA.recommend(10);
  // label only part of the recommended batch
  const actuallyLabeled = batch.slice(0, 4);
  sessionA.markLabeled(actuallyLabeled);
  const nextA = sessionA.recommend(6);

  const fullLabeled = new Set([...initialLabeled, ...actuallyLabeled]);
  const sessionB = new DiversitySession({ samples, representatives: reps, labeledIds: fullLabeled });
  const nextB = sessionB.recommend(6);

  assert.deepEqual(nextA, nextB);
  // no residue: previously recommended-but-unlabeled ids are eligible again
  const residue = batch.slice(4);
  const sessionC = new DiversitySession({ samples, representatives: reps, labeledIds: initialLabeled });
  assert.deepEqual(sessionC.recommend(10), batch);
  void residue;
});

test("markLabeled is idempotent and excludes labeled from candidates", () => {
  const rng = makeRng(45);
  const samples = randomPool(rng, 30);
  const reps = randomReps(rng, 8);
  const session = new DiversitySession({ samples, representatives: reps });
  const ids = samples.map((s) => s.id);
  session.markLabeled([ids[0], ids[1]]);
  session.markLabeled([ids[1], ids[2]]);
  assert.equal(session.labeledCount, 3);
  const rec = session.recommend(200);
  assert.equal(rec.length, 27);
  assert.ok(!rec.includes(ids[0]) && !rec.includes(ids[1]) && !rec.includes(ids[2]));
  assert.equal(new Set(rec).size, rec.length);
});

test("batch has no duplicate ids even with identical features", () => {
  const f = randomFeatures(makeRng(46));
  const samples = [];
  for (let i = 0; i < 10; i++) samples.push({ id: i, features: [...f] });
  const reps = [{ features: randomFeatures(makeRng(47)), weight: 100 }];
  const session = new DiversitySession({ samples, representatives: reps });
  const rec = session.recommend(10);
  assert.equal(new Set(rec).size, 10);
});

test("input validation", () => {
  const rng = makeRng(48);
  const samples = randomPool(rng, 5);
  const reps = randomReps(rng, 3);
  assert.throws(() => new DiversitySession({ samples: [{ id: -1, features: randomFeatures(rng) }], representatives: reps }), /id/);
  assert.throws(() => new DiversitySession({ samples: [{ id: 1.5, features: randomFeatures(rng) }], representatives: reps }), /id/);
  assert.throws(() => new DiversitySession({ samples: [{ id: 0, features: [1, 2] }], representatives: reps }), /length/);
  assert.throws(() => new DiversitySession({ samples: [{ id: 0, features: new Array(16).fill(256) }], representatives: reps }), /features/);
  assert.throws(() => new DiversitySession({ samples: [{ id: 0, features: new Array(16).fill(-1) }], representatives: reps }), /features/);
  assert.throws(() => new DiversitySession({ samples: [{ id: 0, features: new Array(16).fill(1.5) }], representatives: reps }), /features/);
  assert.throws(() => new DiversitySession({ samples: [{ id: 1, features: randomFeatures(rng) }, { id: 1, features: randomFeatures(rng) }], representatives: reps }), /duplicate/);
  assert.throws(() => new DiversitySession({ samples, representatives: [{ features: randomFeatures(rng), weight: 0 }] }), /weight/);
  assert.throws(() => new DiversitySession({ samples, representatives: [{ features: randomFeatures(rng), weight: 10001 }] }), /weight/);
  assert.throws(() => new DiversitySession({ samples, representatives: [{ features: randomFeatures(rng), weight: 2.5 }] }), /weight/);

  const session = new DiversitySession({ samples, representatives: reps });
  assert.throws(() => session.recommend(0), /count/);
  assert.throws(() => session.recommend(201), /count/);
  assert.throws(() => session.recommend(2.5), /count/);
  assert.throws(() => session.markLabeled([999999]), /unknown/);
});

test("empty representative set: every gain is zero, picks by id order", () => {
  const rng = makeRng(49);
  const samples = randomPool(rng, 8);
  const session = new DiversitySession({ samples, representatives: [] });
  const ids = samples.map((s) => s.id).sort((a, b) => a - b);
  assert.deepEqual(session.recommend(5), ids.slice(0, 5));
});

test("empty pool returns empty batch", () => {
  const session = new DiversitySession({ samples: [], representatives: [] });
  assert.deepEqual(session.recommend(10), []);
  assert.equal(session.poolSize, 0);
});

test("all labeled returns empty batch", () => {
  const rng = makeRng(50);
  const samples = randomPool(rng, 4);
  const session = new DiversitySession({
    samples,
    representatives: randomReps(rng, 2),
    labeledIds: samples.map((s) => s.id),
  });
  assert.deepEqual(session.recommend(3), []);
});
