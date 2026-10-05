import { test } from 'node:test';
import * as assert from 'node:assert';
import { Buffer } from 'node:buffer';
import { VisualRegressionLibrary } from '../src/index';
import { computeMatchRate, decodePng } from '../src/png';
import { alterPixels, makePng, makeTempDir, removeTempDir, tick } from './helpers';

const W = 20;
const H = 20;
const NAMES = ['home', 'about', 'profile', 'settings', 'help'];

function screenshots(seed: number): Array<{ name: string; png: Buffer }> {
  return NAMES.map((name, i) => ({ name, png: makePng(W, H, seed * 100 + i) }));
}

test('comparison uses the baseline pinned at submission, independent of interleaved approvals', async () => {
  const dir = makeTempDir();
  try {
    const lib = new VisualRegressionLibrary({ dir, maxRetainedRuns: 50 });

    // v1: seed baseline for every page.
    const seedShots = screenshots(1);
    const seedRun = lib.submitRun(seedShots);
    await lib.waitForIdle();
    assert.deepEqual(lib.approveBaseline(seedRun, NAMES, 0), { ok: true, baselineVersion: 1 });

    // v2, v3: two partial approvals from a second run.
    const newerShots = screenshots(2);
    const newerRun = lib.submitRun(newerShots);
    await lib.waitForIdle();
    assert.deepEqual(lib.approveBaseline(newerRun, ['home'], 1), { ok: true, baselineVersion: 2 });
    assert.deepEqual(lib.approveBaseline(newerRun, ['about'], 2), { ok: true, baselineVersion: 3 });

    // Baseline pinned at the next submission: home/about from newerShots,
    // profile/settings/help from seedShots, version 3.
    const pinned = new Map<string, Buffer>();
    for (const shot of seedShots) pinned.set(shot.name, shot.png);
    pinned.set('home', newerShots[0].png);
    pinned.set('about', newerShots[1].png);

    // Target run: mix of identical, >=98% and clearly different pages.
    const targetShots = NAMES.map((name, i) => {
      const base = pinned.get(name)!;
      if (name === 'home') return { name, png: base }; // 100%
      if (name === 'about') return { name, png: alterPixels(base, W, H, 4) }; // 99%
      if (name === 'profile') return { name, png: alterPixels(base, W, H, 8) }; // 98%
      if (name === 'settings') return { name, png: alterPixels(base, W, H, 200) }; // 50%
      return { name, png: makePng(W, H, 999) }; // ~0%
    });
    const targetRun = lib.submitRun(targetShots);

    // Publish more partial baselines while the comparison is running.
    await tick();
    assert.deepEqual(lib.approveBaseline(newerRun, ['profile'], 3), { ok: true, baselineVersion: 4 });
    await tick();
    assert.deepEqual(lib.approveBaseline(seedRun, ['home'], 4), { ok: true, baselineVersion: 5 });
    await tick();
    assert.deepEqual(lib.approveBaseline(newerRun, ['settings', 'help'], 5), {
      ok: true,
      baselineVersion: 6,
    });

    await lib.waitForIdle();

    const run = lib.getRun(targetRun);
    assert.ok(run, 'run must still be queryable');
    assert.equal(run!.status, 'completed');
    assert.equal(run!.baselineVersion, 3);
    assert.equal(run!.passed, false); // settings and help are below 98%

    // Independently recompute the expected result against the pinned baseline.
    const byName = new Map(run!.images!.map((img) => [img.name, img]));
    for (const shot of targetShots) {
      const expectedRate = computeMatchRate(decodePng(shot.png), decodePng(pinned.get(shot.name)!));
      const actual = byName.get(shot.name)!;
      assert.equal(actual.baselineExists, true, shot.name);
      assert.equal(actual.matchRate, expectedRate, shot.name);
      assert.equal(actual.passed, expectedRate >= 98, shot.name);

      // The baseline image actually used must be retrievable and identical
      // to the one pinned at submission time.
      const imageData = lib.getRunImage(targetRun, shot.name);
      assert.ok(imageData);
      assert.ok(imageData!.screenshot.equals(shot.png), `${shot.name} screenshot`);
      assert.ok(imageData!.baseline!.equals(pinned.get(shot.name)!), `${shot.name} baseline`);
    }

    // The result is immutable after completion.
    const again = lib.getRun(targetRun);
    assert.deepEqual(again, run);

    await lib.close();
  } finally {
    removeTempDir(dir);
  }
});

test('missing baseline for a name fails the run', async () => {
  const dir = makeTempDir();
  try {
    const lib = new VisualRegressionLibrary({ dir });
    const shot = makePng(W, H, 1);
    const runId = lib.submitRun([{ name: 'home', png: shot }]);
    assert.equal(lib.getRun(runId)!.status, 'processing');
    await lib.waitForIdle();
    const run = lib.getRun(runId)!;
    assert.equal(run.status, 'completed');
    assert.equal(run.passed, false);
    assert.deepEqual(run.images, [
      { name: 'home', matchRate: null, baselineExists: false, passed: false },
    ]);
    const imageData = lib.getRunImage(runId, 'home')!;
    assert.ok(imageData.screenshot.equals(shot));
    assert.equal(imageData.baseline, null);
    await lib.close();
  } finally {
    removeTempDir(dir);
  }
});
