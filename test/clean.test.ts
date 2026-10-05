import assert from "node:assert/strict";
import { test } from "node:test";
import { PurgeWaveError } from "../src/index.js";
import { CrashPlan, SimulatedCrash, makeFixture } from "./helpers.js";

test("clean moves multiple files into retention and reports per-file status", (t) => {
  const fx = makeFixture();
  t.after(fx.closeAll);
  const files = [fx.makeFile("a.bin"), fx.makeFile("b.bin"), fx.makeFile("sub/c.bin")];
  const pw = fx.open();

  const report = pw.clean("job-1", files.map((f) => f.path));

  assert.equal(report.jobId, "job-1");
  assert.equal(report.files.length, 3);
  for (const file of files) {
    assert.equal(fx.exists(file.path), false, `${file.path} should be gone`);
    const entry = report.files.find((f) => f.path === file.path);
    assert.equal(entry?.status, "cleaned");
  }
  assert.equal(fx.retainedNames().length, 3);

  const view = pw.getJob("job-1");
  assert.equal(view.files.length, 3);
  assert.ok(view.files.every((f) => f.status === "cleaned"));
});

test("crash after record but before move is resumed on reopen", (t) => {
  const fx = makeFixture();
  t.after(fx.closeAll);
  const files = [fx.makeFile("a.bin"), fx.makeFile("b.bin"), fx.makeFile("c.bin")];
  const paths = files.map((f) => f.path);
  const plan = new CrashPlan([{ point: "clean:claimed", after: 2 }]);
  const pw1 = fx.open(plan);

  assert.throws(() => pw1.clean("job-1", paths), SimulatedCrash);
  const pw2 = fx.reopen(pw1);

  const report = pw2.clean("job-1", paths);
  assert.ok(report.files.every((f) => f.status === "cleaned"));
  for (const file of files) {
    assert.equal(fx.exists(file.path), false);
  }
  assert.equal(fx.retainedNames().length, 3);
});

test("crash after move but before record does not lose the file", (t) => {
  const fx = makeFixture();
  t.after(fx.closeAll);
  const files = [fx.makeFile("a.bin"), fx.makeFile("b.bin"), fx.makeFile("c.bin")];
  const paths = files.map((f) => f.path);
  const plan = new CrashPlan([{ point: "clean:moved", after: 2 }]);
  const pw1 = fx.open(plan);

  assert.throws(() => pw1.clean("job-1", paths), SimulatedCrash);
  const pw2 = fx.reopen(pw1);

  const report = pw2.clean("job-1", paths);
  assert.ok(report.files.every((f) => f.status === "cleaned"));
  assert.equal(fx.retainedNames().length, 3);

  const undoReport = pw2.undo("job-1");
  assert.ok(undoReport.files.every((f) => f.status === "restored"));
  for (const file of files) {
    assert.deepEqual(fx.readFile(file.path), file.content);
  }
});

test("crash after record update resumes with remaining files", (t) => {
  const fx = makeFixture();
  t.after(fx.closeAll);
  const files = [fx.makeFile("a.bin"), fx.makeFile("b.bin"), fx.makeFile("c.bin")];
  const paths = files.map((f) => f.path);
  const plan = new CrashPlan([{ point: "clean:recorded", after: 2 }]);
  const pw1 = fx.open(plan);

  assert.throws(() => pw1.clean("job-1", paths), SimulatedCrash);
  const pw2 = fx.reopen(pw1);

  const report = pw2.clean("job-1", paths);
  assert.ok(report.files.every((f) => f.status === "cleaned"));
  assert.equal(fx.retainedNames().length, 3);
});

test("duplicate clean after crash-before-return keeps first list and ignores new files", (t) => {
  const fx = makeFixture();
  t.after(fx.closeAll);
  const first = fx.makeFile("first.bin");
  const plan = new CrashPlan([{ point: "clean:before-return", after: 1 }]);
  const pw1 = fx.open(plan);

  assert.throws(() => pw1.clean("job-1", [first.path]), SimulatedCrash);

  // caller never got the result; a new file appears at the original path,
  // and the retry passes a different list containing another path
  const replacement = Buffer.from("brand new content at same path");
  fx.writeFile(first.path, replacement);
  const other = fx.makeFile("other.bin");
  const pw2 = fx.reopen(pw1);

  const report = pw2.clean("job-1", [first.path, other.path]);

  assert.equal(report.files.length, 1, "retry must reuse the first received list");
  assert.equal(report.files[0].path, first.path);
  assert.equal(report.files[0].status, "cleaned");
  assert.deepEqual(fx.readFile(first.path), replacement, "new file at original path untouched");
  assert.equal(fx.exists(other.path), true, "path from second list must not be cleaned");
  assert.equal(fx.retainedNames().length, 1);

  const undoReport = pw2.undo("job-1");
  assert.equal(undoReport.files[0].status, "conflict", "occupied original path conflicts");
});

test("clean rejects more than 5000 distinct paths", (t) => {
  const fx = makeFixture();
  t.after(fx.closeAll);
  const pw = fx.open();
  const paths = Array.from({ length: 5001 }, (_, i) => `${fx.dataDir}/f${i}.bin`);
  assert.throws(() => pw.clean("job-big", paths), (err: unknown) => {
    assert.ok(err instanceof PurgeWaveError);
    assert.equal(err.code, "TOO_MANY_PATHS");
    return true;
  });
});

test("clean rejects paths inside the storage dir and unknown jobs", (t) => {
  const fx = makeFixture();
  t.after(fx.closeAll);
  const pw = fx.open();
  const inside = `${fx.storageDir}/sneaky.bin`;
  assert.throws(() => pw.clean("job-x", [inside]), (err: unknown) => {
    assert.ok(err instanceof PurgeWaveError);
    assert.equal(err.code, "PATH_IN_STORAGE");
    return true;
  });
  assert.throws(() => pw.getJob("nope"), (err: unknown) => {
    assert.ok(err instanceof PurgeWaveError);
    assert.equal(err.code, "UNKNOWN_JOB");
    return true;
  });
});
