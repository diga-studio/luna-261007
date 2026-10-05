import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { CrashSim, exists, listBlobs, makeEnv, randomBytes, readFile, writeFiles } from "./helpers.js";

test("re-submitted purge reuses the first list and never re-purges new files", () => {
  const env = makeEnv();
  try {
    const original = [randomBytes(48), randomBytes(48)];
    const paths = writeFiles(env.workDir, { "a.bin": original[0], "b.bin": original[1] });
    const pw = env.open();
    const first = pw.purge("job", paths);

    // New files appear at the original paths between operations.
    const replacements = [Buffer.from("new-a"), Buffer.from("new-b")];
    fs.writeFileSync(paths[0], replacements[0]);
    fs.writeFileSync(paths[1], replacements[1]);

    // Same id, same list: no re-purge of the new files.
    const second = pw.purge("job", paths);
    assert.deepEqual(second, first);
    assert.deepEqual(readFile(paths[0]), replacements[0]);
    assert.deepEqual(readFile(paths[1]), replacements[1]);

    // Same id, different list: the first list still wins.
    const third = pw.purge("job", [path.join(env.workDir, "unrelated.bin")]);
    assert.deepEqual(third, first);
    assert.equal(exists(path.join(env.workDir, "unrelated.bin")), false);
    pw.close();
  } finally {
    env.cleanup();
  }
});

test("purge result lost to a crash: retry after reopen is idempotent", () => {
  const env = makeEnv();
  try {
    const contents = [randomBytes(32), randomBytes(32)];
    const paths = writeFiles(env.workDir, { "p.bin": contents[0], "q.bin": contents[1] });
    // Crash right after the final record commit: work done, result never returned.
    const crashed = env.open(new CrashSim(3).hook);
    assert.throws(() => crashed.purge("job", paths), /simulated crash/);

    const pw = env.open();
    const retry = pw.purge("job", paths);
    assert.ok(retry.entries.every((e) => e.state === "purged"));
    assert.equal(listBlobs(env.storageDir).length, 2);
    pw.close();
  } finally {
    env.cleanup();
  }
});

test("retention is anchored to first receipt: retries and reopens never extend it", () => {
  const env = makeEnv();
  try {
    const paths = writeFiles(env.workDir, { "f.bin": "data" });
    const pw = env.open();
    const first = pw.purge("job", paths);
    pw.close();

    // Retry the submission 10 days later from a fresh module instance.
    env.clock.advance(10 * 24 * 60 * 60 * 1000);
    const pw2 = env.open();
    const retried = pw2.purge("job", paths);
    assert.equal(retried.receivedAt, first.receivedAt);
    assert.equal(retried.deadline, first.deadline);
    pw2.close();

    // At the original deadline the undo must be rejected: no extension.
    env.clock.set(first.deadline);
    const pw3 = env.open();
    assert.throws(() => pw3.undo("job"), /expired/);
    pw3.close();
  } finally {
    env.cleanup();
  }
});

test("reclaim never deletes a new file that later appeared at an original path", () => {
  const env = makeEnv();
  try {
    const paths = writeFiles(env.workDir, { "victim.bin": "old content" });
    const pw = env.open();
    const view = pw.purge("job", paths);
    const newcomer = Buffer.from("new file at the old path");
    fs.writeFileSync(paths[0], newcomer);

    env.clock.set(view.deadline + 1000);
    const done = pw.reclaim("job");
    assert.equal(done.entries[0].state, "reclaimed");
    assert.deepEqual(readFile(paths[0]), newcomer);
    assert.equal(listBlobs(env.storageDir).length, 0);
    pw.close();
  } finally {
    env.cleanup();
  }
});

test("repeated undo and reclaim after completion do not reprocess entries", () => {
  const env = makeEnv();
  try {
    const contents = [randomBytes(32)];
    const paths = writeFiles(env.workDir, { "r.bin": contents[0] });
    const pw = env.open();
    pw.purge("undo-job", paths);
    const undone = pw.undo("undo-job");
    const undoneAgain = pw.undo("undo-job");
    assert.deepEqual(undoneAgain, undone);
    assert.deepEqual(readFile(paths[0]), contents[0]);

    const paths2 = writeFiles(env.workDir, { "s.bin": "x" });
    const view = pw.purge("reclaim-job", paths2);
    env.clock.set(view.deadline);
    const reclaimed = pw.reclaim("reclaim-job");
    const reclaimedAgain = pw.reclaim("reclaim-job");
    assert.deepEqual(reclaimedAgain, reclaimed);
    pw.close();
  } finally {
    env.cleanup();
  }
});

test("orphan retained content that maps to no job entry is swept on open", () => {
  const env = makeEnv();
  try {
    const contents = [randomBytes(32)];
    const paths = writeFiles(env.workDir, { "k.bin": contents[0] });
    const pw = env.open();
    pw.purge("job", paths);
    pw.close();

    // Plant unattributable content: unknown job dir and unknown seq file.
    const blobsDir = path.join(env.storageDir, "blobs");
    fs.mkdirSync(path.join(blobsDir, "ghost-job"), { recursive: true });
    fs.writeFileSync(path.join(blobsDir, "ghost-job", "0"), "orphan");
    fs.writeFileSync(path.join(blobsDir, encodeURIComponent("job"), "99"), "orphan");
    assert.equal(listBlobs(env.storageDir).length, 3);

    const pw2 = env.open();
    assert.deepEqual(listBlobs(env.storageDir), [path.join(encodeURIComponent("job"), "0")]);
    // The legitimate retained content survives and restores correctly.
    const view = pw2.undo("job");
    assert.equal(view.entries[0].state, "restored");
    assert.deepEqual(readFile(paths[0]), contents[0]);
    pw2.close();
  } finally {
    env.cleanup();
  }
});
