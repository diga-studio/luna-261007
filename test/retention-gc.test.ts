import { test } from 'node:test';
import * as assert from 'node:assert';
import { existsSync } from 'node:fs';
import { VisualRegressionLibrary } from '../src/index';
import { makePng, makeTempDir, removeTempDir, storedImagePath } from './helpers';

const W = 16;
const H = 16;

test('pruning keeps referenced images and reclaims unreferenced ones', async () => {
  const dir = makeTempDir();
  try {
    const lib = new VisualRegressionLibrary({ dir, maxRetainedRuns: 1 });

    // run1 becomes the first published baseline (v1).
    const h1 = makePng(W, H, 11);
    const a1 = makePng(W, H, 12);
    const run1 = lib.submitRun([
      { name: 'home', png: h1 },
      { name: 'about', png: a1 },
    ]);
    await lib.waitForIdle();
    assert.deepEqual(lib.approveBaseline(run1, ['home', 'about'], 0), {
      ok: true,
      baselineVersion: 1,
    });
    await lib.waitForIdle();

    // run2 completes -> run1 exceeds the retention limit and is pruned.
    const h2 = makePng(W, H, 21);
    const a2 = makePng(W, H, 22);
    const run2 = lib.submitRun([
      { name: 'home', png: h2 },
      { name: 'about', png: a2 },
    ]);
    await lib.waitForIdle();
    assert.equal(lib.getRun(run1), null, 'pruned run must not be queryable');

    // run1's images still form the current baseline and run2's pinned
    // comparison baseline, so they must survive pruning.
    assert.ok(existsSync(storedImagePath(dir, h1)), 'h1 still referenced by baseline');
    assert.ok(existsSync(storedImagePath(dir, a1)), 'a1 still referenced by baseline');
    const run2Home = lib.getRunImage(run2, 'home')!;
    assert.ok(run2Home.baseline!.equals(h1), 'run2 compared against h1');

    // Approve run2's home: baseline becomes { home: h2, about: a1 } (v2).
    assert.deepEqual(lib.approveBaseline(run2, ['home'], 1), { ok: true, baselineVersion: 2 });

    // run3 completes -> run2 is pruned. h1 (only referenced by run2's pinned
    // baseline) and a2 (run2 screenshot, never approved) become unreferenced.
    const h3 = makePng(W, H, 31);
    const a3 = makePng(W, H, 32);
    const run3 = lib.submitRun([
      { name: 'home', png: h3 },
      { name: 'about', png: a3 },
    ]);
    await lib.waitForIdle();
    assert.equal(lib.getRun(run2), null, 'run2 pruned');
    assert.ok(lib.getRun(run3), 'newest completed run retained');

    // Referenced images remain readable: current baseline (h2, a1), run3's
    // screenshots (h3, a3) and run3's pinned baseline (h2, a1).
    for (const png of [h2, a1, h3, a3]) {
      assert.ok(existsSync(storedImagePath(dir, png)), 'referenced image kept');
    }
    const run3Home = lib.getRunImage(run3, 'home')!;
    assert.ok(run3Home.screenshot.equals(h3));
    assert.ok(run3Home.baseline!.equals(h2));
    const run3About = lib.getRunImage(run3, 'about')!;
    assert.ok(run3About.baseline!.equals(a1));

    // waitForIdle only resolves after garbage collection finished.
    assert.ok(!existsSync(storedImagePath(dir, h1)), 'h1 reclaimed');
    assert.ok(!existsSync(storedImagePath(dir, a2)), 'a2 reclaimed');

    await lib.close();
  } finally {
    removeTempDir(dir);
  }
});

test('unfinished runs are neither counted nor pruned', async () => {
  const dir = makeTempDir();
  try {
    const lib = new VisualRegressionLibrary({ dir, maxRetainedRuns: 1 });
    const run1 = lib.submitRun([{ name: 'home', png: makePng(W, H, 1) }]);
    await lib.waitForIdle();

    // Submit two runs back to back; while run2 is still processing only one
    // completed run exists, so nothing may be pruned yet.
    const run2 = lib.submitRun([{ name: 'home', png: makePng(W, H, 2) }]);
    const run3 = lib.submitRun([{ name: 'home', png: makePng(W, H, 3) }]);
    assert.ok(lib.getRun(run1), 'run1 retained while run2/run3 process');
    assert.ok(lib.getRun(run2));
    assert.ok(lib.getRun(run3));

    await lib.waitForIdle();
    // After everything settles only the newest completed run remains.
    assert.equal(lib.getRun(run1), null);
    assert.equal(lib.getRun(run2), null);
    assert.ok(lib.getRun(run3));
    assert.equal(lib.getRun(run3)!.status, 'completed');
    await lib.close();
  } finally {
    removeTempDir(dir);
  }
});
