import { test } from 'node:test';
import * as assert from 'node:assert';
import { VisualRegressionLibrary } from '../src/index';
import { makePng, makeTempDir, removeTempDir } from './helpers';

const W = 16;
const H = 16;

test('approval requires matching version and never takes partial effect', async () => {
  const dir = makeTempDir();
  try {
    const lib = new VisualRegressionLibrary({ dir, maxRetainedRuns: 10 });
    const home1 = makePng(W, H, 1);
    const about1 = makePng(W, H, 2);
    const run1 = lib.submitRun([
      { name: 'home', png: home1 },
      { name: 'about', png: about1 },
    ]);
    await lib.waitForIdle();

    // Approving a still-processing run fails.
    const pending = lib.submitRun([{ name: 'home', png: makePng(W, H, 3) }]);
    assert.deepEqual(lib.approveBaseline(pending, ['home'], 0), {
      ok: false,
      error: 'run_not_completed',
    });
    await lib.waitForIdle();

    // Unknown screenshot names fail and publish nothing.
    assert.deepEqual(lib.approveBaseline(run1, ['home', 'nope'], 0), {
      ok: false,
      error: 'unknown_names',
    });
    assert.deepEqual(lib.getBaseline(), { version: 0, names: [] });

    // First approval publishes only the selected names.
    assert.deepEqual(lib.approveBaseline(run1, ['home'], 0), { ok: true, baselineVersion: 1 });
    assert.deepEqual(lib.getBaseline(), { version: 1, names: ['home'] });

    // Stale expected version conflicts; nothing changes and nothing retries.
    assert.deepEqual(lib.approveBaseline(run1, ['about'], 0), {
      ok: false,
      error: 'version_conflict',
    });
    assert.deepEqual(lib.getBaseline(), { version: 1, names: ['home'] });

    // Correct version publishes the rest.
    assert.deepEqual(lib.approveBaseline(run1, ['about'], 1), { ok: true, baselineVersion: 2 });
    assert.deepEqual(lib.getBaseline(), { version: 2, names: ['about', 'home'] });

    // Unknown run id.
    assert.deepEqual(lib.approveBaseline('missing-run', ['home'], 2), {
      ok: false,
      error: 'run_not_found',
    });

    await lib.close();
  } finally {
    removeTempDir(dir);
  }
});

test('approving a pruned run fails with run_not_found', async () => {
  const dir = makeTempDir();
  try {
    const lib = new VisualRegressionLibrary({ dir, maxRetainedRuns: 1 });
    const run1 = lib.submitRun([{ name: 'home', png: makePng(W, H, 1) }]);
    await lib.waitForIdle();
    const run2 = lib.submitRun([{ name: 'home', png: makePng(W, H, 2) }]);
    await lib.waitForIdle();
    assert.equal(lib.getRun(run1), null);
    assert.deepEqual(lib.approveBaseline(run1, ['home'], 0), {
      ok: false,
      error: 'run_not_found',
    });
    assert.ok(lib.getRun(run2));
    await lib.close();
  } finally {
    removeTempDir(dir);
  }
});
