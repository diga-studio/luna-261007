import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { listBlobs, makeEnv, randomBytes, readFile, writeFiles } from "./helpers.js";

test("occupied original path: conflict recorded, others restored, retry continues", () => {
  const env = makeEnv();
  try {
    const contents = [randomBytes(64), randomBytes(64), randomBytes(64)];
    const paths = writeFiles(env.workDir, {
      "a.bin": contents[0],
      "b.bin": contents[1],
      "c.bin": contents[2],
    });
    const pw = env.open();
    pw.purge("job", paths);
    // A new file appears at one original path between operations.
    const occupant = Buffer.from("brand new occupant");
    fs.writeFileSync(paths[1], occupant);

    const view = pw.undo("job");
    const byPath = new Map(view.entries.map((e) => [e.path, e.state]));
    assert.equal(byPath.get(paths[0]), "restored");
    assert.equal(byPath.get(paths[1]), "conflict");
    assert.equal(byPath.get(paths[2]), "restored");

    // The occupant is never overwritten or deleted; conflict content retained.
    assert.deepEqual(readFile(paths[1]), occupant);
    assert.deepEqual(readFile(paths[0]), contents[0]);
    assert.deepEqual(readFile(paths[2]), contents[2]);
    assert.equal(listBlobs(env.storageDir).length, 1);

    // Conflict state survives reopening the module.
    pw.close();
    const pw2 = env.open();
    const view2 = pw2.getJob("job");
    assert.ok(view2);
    assert.equal(view2.entries.find((e) => e.path === paths[1])?.state, "conflict");
    assert.equal(listBlobs(env.storageDir).length, 1);

    // Once the occupant is gone, a repeated undo restores only that file.
    fs.rmSync(paths[1]);
    const view3 = pw2.undo("job");
    assert.ok(view3.entries.every((e) => e.state === "restored"));
    assert.deepEqual(readFile(paths[1]), contents[1]);
    assert.equal(listBlobs(env.storageDir).length, 0);
    pw2.close();
  } finally {
    env.cleanup();
  }
});

test("a directory occupying the original path also causes conflict", () => {
  const env = makeEnv();
  try {
    const contents = [randomBytes(32)];
    const paths = writeFiles(env.workDir, { "x.bin": contents[0] });
    const pw = env.open();
    pw.purge("job", paths);
    fs.mkdirSync(paths[0]);
    const view = pw.undo("job");
    assert.equal(view.entries[0].state, "conflict");
    assert.ok(fs.statSync(paths[0]).isDirectory());
    assert.equal(listBlobs(env.storageDir).length, 1);
    pw.close();
  } finally {
    env.cleanup();
  }
});

test("reclaim deletes conflict-retained content but never the occupant", () => {
  const env = makeEnv();
  try {
    const contents = [randomBytes(32), randomBytes(32)];
    const paths = writeFiles(env.workDir, { "m.bin": contents[0], "n.bin": contents[1] });
    const pw = env.open();
    const view = pw.purge("job", paths);
    const occupant = Buffer.from("occupant");
    fs.writeFileSync(paths[0], occupant);
    pw.undo("job"); // paths[0] -> conflict, paths[1] -> restored

    env.clock.set(view.deadline);
    const done = pw.reclaim("job");
    const byPath = new Map(done.entries.map((e) => [e.path, e.state]));
    assert.equal(byPath.get(paths[0]), "reclaimed");
    assert.equal(byPath.get(paths[1]), "restored");
    // Occupant at the original path is untouched; restored file intact.
    assert.deepEqual(readFile(paths[0]), occupant);
    assert.deepEqual(readFile(paths[1]), contents[1]);
    assert.equal(listBlobs(env.storageDir).length, 0);
    pw.close();
  } finally {
    env.cleanup();
  }
});
