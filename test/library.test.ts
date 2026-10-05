import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RunNotFoundError,
  VersionConflictError,
  VisualRegressionBaseline,
  type RunCompleted,
} from '../src/index.js';
import { computeMatchRate, decodePng } from '../src/png.js';
import {
  imageIdOf,
  listImageFiles,
  makeTempDir,
  pngWithChangedPixels,
  solidPng,
} from './helpers.js';

function completed(info: ReturnType<VisualRegressionBaseline['getRun']>): RunCompleted {
  assert.equal(info.status, 'completed');
  return info as RunCompleted;
}

test('missing baseline fails the run; query shows processing then complete result', async () => {
  const dir = makeTempDir();
  const lib = new VisualRegressionBaseline({ dir, maxRetainedRuns: 10 });
  try {
    assert.equal(lib.getBaselineVersion(), 0);
    const home = solidPng(10, 20, 30);
    const runId = lib.submitRun([{ name: 'home', png: home }]);
    assert.equal(lib.getRun(runId).status, 'processing');
    await lib.waitForIdle();
    const info = completed(lib.getRun(runId));
    assert.equal(info.passed, false);
    assert.equal(info.baselineVersion, 0);
    assert.deepEqual(info.images, [{ name: 'home', matchRate: null, passed: false }]);
    const images = lib.getRunImages(runId);
    assert.deepEqual(images[0].screenshot, home);
    assert.equal(images[0].baseline, null);
  } finally {
    lib.close();
  }
});

test('approvals published during comparison do not change its result', async () => {
  const dir = makeTempDir();
  const lib = new VisualRegressionBaseline({ dir, maxRetainedRuns: 10 });
  try {
    const h1 = solidPng(10, 20, 30);
    const c1 = solidPng(40, 50, 60);
    const h2 = solidPng(11, 21, 31);
    const c3 = solidPng(44, 55, 66);

    // Publish v1 baseline: home=h1, cart=c1.
    const runA = lib.submitRun([
      { name: 'home', png: h1 },
      { name: 'cart', png: c1 },
    ]);
    await lib.waitForIdle();
    assert.equal(lib.approve(runA, ['home', 'cart'], 0), 1);

    // Completed runs carrying future baseline content.
    const runB = lib.submitRun([{ name: 'home', png: h2 }]);
    const runC = lib.submitRun([{ name: 'cart', png: c3 }]);
    await lib.waitForIdle();

    // Run under test pins baseline v1.
    const hT = pngWithChangedPixels(h1, 1, 9, 9, 9); // 99% of h1
    const cT = pngWithChangedPixels(c1, 50, 9, 9, 9); // 50% of c1
    const runT = lib.submitRun([
      { name: 'home', png: hT },
      { name: 'cart', png: cT },
    ]);
    assert.equal(lib.getRun(runT).status, 'processing');

    // Consecutive partial approvals land while the comparison is pending.
    assert.equal(lib.approve(runB, ['home'], 1), 2);
    assert.equal(lib.approve(runC, ['cart'], 2), 3);
    assert.equal(lib.getBaselineVersion(), 3);

    await lib.waitForIdle();
    const info = completed(lib.getRun(runT));
    assert.equal(info.baselineVersion, 1);
    assert.equal(info.passed, false);
    const byName = new Map(info.images.map((image) => [image.name, image]));

    // Independent recomputation against the submission-time (v1) baseline.
    assert.equal(byName.get('home')!.matchRate, computeMatchRate(decodePng(hT), decodePng(h1)));
    assert.equal(byName.get('cart')!.matchRate, computeMatchRate(decodePng(cT), decodePng(c1)));
    assert.equal(byName.get('home')!.passed, true);
    assert.equal(byName.get('cart')!.passed, false);

    // The baseline images actually used remain retrievable and stable.
    const runImages = new Map(lib.getRunImages(runT).map((image) => [image.name, image]));
    assert.deepEqual(runImages.get('home')!.baseline, h1);
    assert.deepEqual(runImages.get('cart')!.baseline, c1);
    assert.deepEqual(runImages.get('home')!.screenshot, hT);

    // The complete result does not change afterwards.
    assert.deepEqual(completed(lib.getRun(runT)), info);
  } finally {
    lib.close();
  }
});

test('approval requires matching version and applies all-or-nothing', async () => {
  const dir = makeTempDir();
  const lib = new VisualRegressionBaseline({ dir, maxRetainedRuns: 10 });
  try {
    const h1 = solidPng(1, 2, 3);
    const run1 = lib.submitRun([{ name: 'home', png: h1 }]);
    // Cannot approve a run that has not completed.
    assert.throws(() => lib.approve(run1, ['home'], 0), /has not completed/);
    await lib.waitForIdle();
    assert.equal(lib.approve(run1, ['home'], 0), 1);

    // Stale expected version: conflict, no retry, nothing changes.
    assert.throws(() => lib.approve(run1, ['home'], 0), VersionConflictError);
    assert.equal(lib.getBaselineVersion(), 1);

    // Unknown name in the batch: whole approval fails, nothing is published.
    assert.throws(() => lib.approve(run1, ['home', 'nope'], 1), /no screenshot named/);
    assert.equal(lib.getBaselineVersion(), 1);

    // Baseline content is untouched: a new run still matches h1 at 100%.
    const run2 = lib.submitRun([{ name: 'home', png: h1 }]);
    await lib.waitForIdle();
    const info = completed(lib.getRun(run2));
    assert.equal(info.passed, true);
    assert.equal(info.images[0].matchRate, 100);

    // A correct retry with the current version still works.
    assert.equal(lib.approve(run1, ['home'], 1), 2);
    assert.equal(lib.getBaselineVersion(), 2);
  } finally {
    lib.close();
  }
});

test('retention cleans oldest completed runs; referenced images survive, unreferenced are reclaimed', async () => {
  const dir = makeTempDir();
  const lib = new VisualRegressionBaseline({ dir, maxRetainedRuns: 1 });
  try {
    const a1 = solidPng(1, 2, 3);
    const x1 = solidPng(7, 8, 9); // never approved, only in run1
    const run1 = lib.submitRun([
      { name: 'pageA', png: a1 },
      { name: 'pageX', png: x1 },
    ]);
    await lib.waitForIdle();
    assert.equal(lib.approve(run1, ['pageA'], 0), 1);

    // run2 pins baseline v1, i.e. the a1 image that came from run1.
    const a2 = pngWithChangedPixels(a1, 1, 250, 250, 250); // 99% of a1
    const run2 = lib.submitRun([{ name: 'pageA', png: a2 }]);
    await lib.waitForIdle();

    // run1 exceeded the retention limit and was cleaned.
    assert.throws(() => lib.getRun(run1), RunNotFoundError);
    assert.throws(() => lib.getRunImages(run1), RunNotFoundError);

    // run2 is retained; its result used a1 as baseline and stays readable.
    const info = completed(lib.getRun(run2));
    assert.equal(info.baselineVersion, 1);
    assert.equal(info.passed, true);
    assert.equal(info.images[0].matchRate, 99);
    const images = lib.getRunImages(run2);
    assert.deepEqual(images[0].baseline, a1);
    assert.deepEqual(images[0].screenshot, a2);

    // After waitForIdle, GC has removed the unreferenced x1 image while
    // a1 (current baseline + run2's pinned baseline) and a2 (run2) remain.
    assert.deepEqual(
      listImageFiles(dir),
      [`${imageIdOf(a1)}.png`, `${imageIdOf(a2)}.png`].sort(),
    );

    // The current baseline still serves a1 even though its source run is gone.
    const run3 = lib.submitRun([{ name: 'pageA', png: a1 }]);
    await lib.waitForIdle();
    assert.equal(completed(lib.getRun(run3)).images[0].matchRate, 100);
  } finally {
    lib.close();
  }
});
