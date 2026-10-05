import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { CrashPlan, SimulatedCrash, makeFixture } from "./helpers.js";

test("undo restores every file byte-for-byte", (t) => {
  const fx = makeFixture();
  t.after(fx.closeAll);
  const files = [fx.makeFile("a.bin", 128), fx.makeFile("b.bin", 1), fx.makeFile("sub/c.bin", 1024)];
  const pw = fx.open();
  pw.clean("job-1", files.map((f) => f.path));

  const report = pw.undo("job-1");

  assert.ok(report.files.every((f) => f.status === "restored"));
  for (const file of files) {
    assert.deepEqual(fx.readFile(file.path), file.content);
  }
  assert.equal(fx.retainedNames().length, 0, "no retained content left");
});

test("crash mid-undo is resumed on reopen with identical bytes", (t) => {
  const fx = makeFixture();
  t.after(fx.closeAll);
  const files = [fx.makeFile("a.bin"), fx.makeFile("b.bin"), fx.makeFile("c.bin"), fx.makeFile("d.bin")];
  const paths = files.map((f) => f.path);
  const pw1 = fx.open();
  pw1.clean("job-1", paths);

  const plan = new CrashPlan([{ point: "undo:moved", after: 2 }]);
  const pw2 = fx.reopen(pw1, plan);
  assert.throws(() => pw2.undo("job-1"), SimulatedCrash);

  const pw3 = fx.reopen(pw2);
  const report = pw3.undo("job-1");

  assert.ok(report.files.every((f) => f.status === "restored"));
  for (const file of files) {
    assert.deepEqual(fx.readFile(file.path), file.content);
  }
  assert.equal(fx.retainedNames().length, 0);
});

test("crash after undo record update resumes remaining files", (t) => {
  const fx = makeFixture();
  t.after(fx.closeAll);
  const files = [fx.makeFile("a.bin"), fx.makeFile("b.bin"), fx.makeFile("c.bin")];
  const paths = files.map((f) => f.path);
  const pw1 = fx.open();
  pw1.clean("job-1", paths);

  const plan = new CrashPlan([{ point: "undo:recorded", after: 1 }]);
  const pw2 = fx.reopen(pw1, plan);
  assert.throws(() => pw2.undo("job-1"), SimulatedCrash);

  const pw3 = fx.reopen(pw2);
  const report = pw3.undo("job-1");
  assert.ok(report.files.every((f) => f.status === "restored"));
  for (const file of files) {
    assert.deepEqual(fx.readFile(file.path), file.content);
  }
});

test("undo result lost before return: retry does not reprocess restored files", (t) => {
  const fx = makeFixture();
  t.after(fx.closeAll);
  const files = [fx.makeFile("a.bin"), fx.makeFile("b.bin")];
  const paths = files.map((f) => f.path);
  const pw1 = fx.open();
  pw1.clean("job-1", paths);

  const plan = new CrashPlan([{ point: "undo:before-return", after: 1 }]);
  const pw2 = fx.reopen(pw1, plan);
  assert.throws(() => pw2.undo("job-1"), SimulatedCrash);

  // caller retries after reopen; files are already back in place
  const pw3 = fx.reopen(pw2);
  const report = pw3.undo("job-1");
  assert.ok(report.files.every((f) => f.status === "restored"));
  for (const file of files) {
    assert.deepEqual(fx.readFile(file.path), file.content);
  }
});

test("occupied original path conflicts, keeps content, and recovers on retry", (t) => {
  const fx = makeFixture();
  t.after(fx.closeAll);
  const blocked = fx.makeFile("blocked.bin");
  const free = fx.makeFile("free.bin");
  const pw = fx.open();
  pw.clean("job-1", [blocked.path, free.path]);

  const occupant = Buffer.from("occupant");
  fx.writeFile(blocked.path, occupant);

  const first = pw.undo("job-1");
  const blockedEntry = first.files.find((f) => f.path === blocked.path);
  const freeEntry = first.files.find((f) => f.path === free.path);
  assert.equal(blockedEntry?.status, "conflict");
  assert.equal(freeEntry?.status, "restored");
  assert.deepEqual(fx.readFile(blocked.path), occupant, "occupant must not be overwritten");
  assert.deepEqual(fx.readFile(free.path), free.content);
  assert.equal(fx.retainedNames().length, 1, "conflicted content is still retained");

  // occupancy cleared; a second undo restores only the conflicted file
  rmSync(blocked.path);
  const second = pw.undo("job-1");
  const blockedSecond = second.files.find((f) => f.path === blocked.path);
  const freeSecond = second.files.find((f) => f.path === free.path);
  assert.equal(blockedSecond?.status, "restored");
  assert.equal(freeSecond?.status, "restored");
  assert.deepEqual(fx.readFile(blocked.path), blocked.content);
  assert.equal(fx.retainedNames().length, 0);
});

test("conflict survives crash and reopen; undo resumes after unblock", (t) => {
  const fx = makeFixture();
  t.after(fx.closeAll);
  const blocked = fx.makeFile("blocked.bin");
  const other = fx.makeFile("other.bin");
  const pw1 = fx.open();
  pw1.clean("job-1", [blocked.path, other.path]);
  fx.writeFile(blocked.path, "occupant");

  const plan = new CrashPlan([{ point: "undo:conflict", after: 1 }]);
  const pw2 = fx.reopen(pw1, plan);
  assert.throws(() => pw2.undo("job-1"), SimulatedCrash);

  const pw3 = fx.reopen(pw2);
  const view = pw3.getJob("job-1");
  assert.equal(view.files.find((f) => f.path === blocked.path)?.status, "conflict");
  assert.equal(view.files.find((f) => f.path === other.path)?.status, "restored");
  assert.equal(fx.retainedNames().length, 1);

  rmSync(blocked.path);
  const report = pw3.undo("job-1");
  assert.equal(report.files.find((f) => f.path === blocked.path)?.status, "restored");
  assert.deepEqual(fx.readFile(blocked.path), blocked.content);
  assert.equal(fx.retainedNames().length, 0);
});
