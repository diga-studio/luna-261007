import { test } from "node:test";
import assert from "node:assert/strict";
import { CrashSim, exists, listBlobs, makeEnv, randomBytes, readFile, writeFiles } from "./helpers.js";

const FILE_COUNT = 3;

function setupFiles(env: ReturnType<typeof makeEnv>) {
  const contents = Array.from({ length: FILE_COUNT }, (_, i) => randomBytes(128 + i));
  const files: Record<string, Buffer> = {};
  contents.forEach((c, i) => {
    files[`f${i}.bin`] = c;
  });
  const paths = writeFiles(env.workDir, files);
  return { contents, paths };
}

// Purge emits 2 fault events per file (after rename, after record commit).
// Crashing at every possible point must still converge to a fully purged job.
for (let failAfter = 0; failAfter <= FILE_COUNT * 2; failAfter++) {
  test(`crash during purge at event ${failAfter}: reopen finishes the job`, () => {
    const env = makeEnv();
    try {
      const { contents, paths } = setupFiles(env);
      const sim = new CrashSim(failAfter);
      const crashed = env.open(sim.hook);
      try {
        crashed.purge("job", paths);
      } catch (err) {
        assert.match((err as Error).message, /simulated crash/);
      }
      // Abandon the crashed instance (no close) and reopen: recovery runs.
      const pw = env.open();
      const view = pw.getJob("job");
      assert.ok(view, "job must not be forgotten once received");
      assert.ok(view);
      assert.ok(view.entries.every((e) => e.state === "purged"));
      for (let i = 0; i < FILE_COUNT; i++) {
        assert.equal(exists(paths[i]), false);
      }
      assert.equal(listBlobs(env.storageDir).length, FILE_COUNT);
      // Retained content is intact and restorable byte-for-byte.
      const undone = pw.undo("job");
      assert.ok(undone.entries.every((e) => e.state === "restored"));
      for (let i = 0; i < FILE_COUNT; i++) {
        assert.deepEqual(readFile(paths[i]), contents[i]);
      }
      pw.close();
    } finally {
      env.cleanup();
    }
  });
}

for (let failAfter = 0; failAfter <= FILE_COUNT * 2; failAfter++) {
  test(`crash during undo at event ${failAfter}: reopen finishes the restore`, () => {
    const env = makeEnv();
    try {
      const { contents, paths } = setupFiles(env);
      const first = env.open();
      first.purge("job", paths);
      first.close();

      const sim = new CrashSim(failAfter);
      const crashed = env.open(sim.hook);
      try {
        crashed.undo("job");
      } catch (err) {
        assert.match((err as Error).message, /simulated crash/);
      }
      const pw = env.open();
      const view = pw.getJob("job");
      assert.ok(view);
      assert.ok(view.entries.every((e) => e.state === "restored"));
      for (let i = 0; i < FILE_COUNT; i++) {
        assert.deepEqual(readFile(paths[i]), contents[i]);
      }
      assert.equal(listBlobs(env.storageDir).length, 0);
      pw.close();
    } finally {
      env.cleanup();
    }
  });
}

for (let failAfter = 0; failAfter <= FILE_COUNT * 2; failAfter++) {
  test(`crash during reclaim at event ${failAfter}: reopen finishes the reclaim`, () => {
    const env = makeEnv();
    try {
      const { paths } = setupFiles(env);
      const first = env.open();
      const view = first.purge("job", paths);
      first.close();

      env.clock.set(view.deadline);
      const sim = new CrashSim(failAfter);
      const crashed = env.open(sim.hook);
      try {
        crashed.reclaim("job");
      } catch (err) {
        assert.match((err as Error).message, /simulated crash/);
      }
      const pw = env.open();
      const after = pw.getJob("job");
      assert.ok(after);
      assert.ok(after.entries.every((e) => e.state === "reclaimed"));
      assert.equal(listBlobs(env.storageDir).length, 0);
      // Original paths were never recreated or touched by reclaim.
      for (const p of paths) assert.equal(exists(p), false);
      pw.close();
    } finally {
      env.cleanup();
    }
  });
}

test("crash after job record but before any file move: purge still completes", () => {
  const env = makeEnv();
  try {
    const { contents, paths } = setupFiles(env);
    // Crash on the very first fault event (before the first rename).
    const crashed = env.open(new CrashSim(0).hook);
    try {
      crashed.purge("job", paths);
    } catch {
      // expected
    }
    const pw = env.open();
    const view = pw.getJob("job");
    assert.ok(view);
    assert.ok(view.entries.every((e) => e.state === "purged"));
    const undone = pw.undo("job");
    assert.ok(undone.entries.every((e) => e.state === "restored"));
    for (let i = 0; i < FILE_COUNT; i++) {
      assert.deepEqual(readFile(paths[i]), contents[i]);
    }
    pw.close();
  } finally {
    env.cleanup();
  }
});
