import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { RETENTION_MS } from "../src/index.js";
import { exists, listBlobs, makeEnv, randomBytes, readFile, writeFiles } from "./helpers.js";

test("purge moves files out and retains content; getJob maps states to paths", () => {
  const env = makeEnv();
  try {
    const contents = [randomBytes(100), randomBytes(1), randomBytes(4096)];
    const paths = writeFiles(env.workDir, {
      "a.bin": contents[0],
      "sub/b.bin": contents[1],
      "c.bin": contents[2],
    });
    const pw = env.open();
    const view = pw.purge("job-1", paths);

    assert.equal(view.jobId, "job-1");
    assert.equal(view.entries.length, 3);
    for (const e of view.entries) assert.equal(e.state, "purged");
    assert.deepEqual(
      view.entries.map((e) => e.path).sort(),
      paths.slice().sort(),
    );
    for (const p of paths) assert.equal(exists(p), false, `${p} should be gone`);
    assert.equal(listBlobs(env.storageDir).length, 3);

    // Retention anchor: deadline is receivedAt + 30*24h.
    assert.equal(view.deadline, view.receivedAt + RETENTION_MS);

    const again = pw.getJob("job-1");
    assert.deepEqual(again, view);
    assert.equal(pw.getJob("nope"), undefined);
    pw.close();
  } finally {
    env.cleanup();
  }
});

test("undo restores byte-identical content to original paths", () => {
  const env = makeEnv();
  try {
    const contents = [randomBytes(500), randomBytes(64)];
    const paths = writeFiles(env.workDir, { "x.bin": contents[0], "y.bin": contents[1] });
    const pw = env.open();
    pw.purge("job-2", paths);
    const view = pw.undo("job-2");

    for (const e of view.entries) assert.equal(e.state, "restored");
    assert.deepEqual(readFile(paths[0]), contents[0]);
    assert.deepEqual(readFile(paths[1]), contents[1]);
    assert.equal(listBlobs(env.storageDir).length, 0);

    // Repeated undo is a no-op on restored files.
    const again = pw.undo("job-2");
    assert.deepEqual(again, view);
    pw.close();
  } finally {
    env.cleanup();
  }
});

test("reclaim before deadline is a no-op; after deadline deletes retained content only", () => {
  const env = makeEnv();
  try {
    const contents = [randomBytes(32), randomBytes(32)];
    const paths = writeFiles(env.workDir, { "p.bin": contents[0], "q.bin": contents[1] });
    const pw = env.open();
    const view = pw.purge("job-3", paths);

    const early = pw.reclaim("job-3");
    assert.ok(early.entries.every((e) => e.state === "purged"));
    assert.equal(listBlobs(env.storageDir).length, 2);

    env.clock.set(view.deadline);
    const done = pw.reclaim("job-3");
    assert.ok(done.entries.every((e) => e.state === "reclaimed"));
    assert.equal(listBlobs(env.storageDir).length, 0);

    // Repeated reclaim does not touch anything again.
    const again = pw.reclaim("job-3");
    assert.deepEqual(again, done);
    pw.close();
  } finally {
    env.cleanup();
  }
});

test("undo is allowed before the deadline and rejected at it", () => {
  const env = makeEnv();
  try {
    const paths = writeFiles(env.workDir, { "f.bin": "data" });
    const pw = env.open();
    const view = pw.purge("job-4", paths);
    env.clock.set(view.deadline - 1);
    // Still allowed one ms before the deadline.
    const restored = pw.undo("job-4");
    assert.equal(restored.entries[0].state, "restored");
    pw.close();
  } finally {
    env.cleanup();
  }

  const env2 = makeEnv();
  try {
    const paths = writeFiles(env2.workDir, { "f.bin": "data" });
    const pw = env2.open();
    const view = pw.purge("job-5", paths);
    env2.clock.set(view.deadline);
    assert.throws(() => pw.undo("job-5"), /expired/);
    pw.close();
  } finally {
    env2.cleanup();
  }
});

test("input validation: unknown job, empty id, >5000 paths, dedupe", () => {
  const env = makeEnv();
  try {
    const pw = env.open();
    assert.throws(() => pw.undo("ghost"), /unknown job/);
    assert.throws(() => pw.reclaim("ghost"), /unknown job/);
    assert.throws(() => pw.purge("", ["a"]), /jobId/);
    assert.throws(() => pw.purge("big", Array.from({ length: 5001 }, (_, i) => `f${i}`)), /5000/);
    assert.throws(() => pw.purge("empty", []), /empty/);

    const p = path.join(env.workDir, "dup.bin");
    writeFiles(env.workDir, { "dup.bin": "x" });
    const view = pw.purge("dedup", [p, p, p]);
    assert.equal(view.entries.length, 1);
    pw.close();
  } finally {
    env.cleanup();
  }
});

test("missing source file is recorded per-file and does not block others", () => {
  const env = makeEnv();
  try {
    const [real] = writeFiles(env.workDir, { "real.bin": "r" });
    const ghost = path.join(env.workDir, "ghost.bin");
    const pw = env.open();
    const view = pw.purge("job-6", [real, ghost]);
    const byPath = new Map(view.entries.map((e) => [e.path, e.state]));
    assert.equal(byPath.get(real), "purged");
    assert.equal(byPath.get(ghost), "missing");
    pw.close();
  } finally {
    env.cleanup();
  }
});
