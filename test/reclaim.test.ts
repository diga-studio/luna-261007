import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PurgeWaveError } from "../src/index.js";
import { CrashPlan, RETENTION_MS, SimulatedCrash, T0, makeFixture } from "./helpers.js";

test("reclaim before expiry and undo at expiry are rejected", (t) => {
  const fx = makeFixture();
  t.after(fx.closeAll);
  const file = fx.makeFile("a.bin");
  const pw = fx.open();
  pw.clean("job-1", [file.path]);

  assert.throws(() => pw.reclaim("job-1"), (err: unknown) => {
    assert.ok(err instanceof PurgeWaveError);
    assert.equal(err.code, "NOT_EXPIRED");
    return true;
  });

  fx.clock.set(T0 + RETENTION_MS - 1);
  assert.throws(() => pw.reclaim("job-1"), (err: unknown) => {
    assert.equal((err as PurgeWaveError).code, "NOT_EXPIRED");
    return true;
  });
  const undoReport = pw.undo("job-1");
  assert.equal(undoReport.files[0].status, "restored", "undo still allowed 1ms before deadline");
});

test("undo at exactly the deadline is rejected; reclaim at the deadline purges", (t) => {
  const fx = makeFixture();
  t.after(fx.closeAll);
  const file = fx.makeFile("a.bin");
  const pw = fx.open();
  pw.clean("job-1", [file.path]);

  fx.clock.set(T0 + RETENTION_MS);
  assert.throws(() => pw.undo("job-1"), (err: unknown) => {
    assert.ok(err instanceof PurgeWaveError);
    assert.equal(err.code, "EXPIRED");
    return true;
  });

  const report = pw.reclaim("job-1");
  assert.equal(report.files[0].status, "purged");
  assert.equal(fx.retainedNames().length, 0);
  assert.equal(fx.exists(file.path), false, "original path stays empty");

  const view = pw.getJob("job-1");
  assert.equal(view.files[0].status, "purged");
});

test("retention window is fixed at first receipt and never extended", (t) => {
  const fx = makeFixture();
  t.after(fx.closeAll);
  const file = fx.makeFile("a.bin");
  const pw1 = fx.open();
  pw1.clean("job-1", [file.path]);

  // reopen and retry the same clean much later; expiry must not move
  fx.clock.advance(10 * 24 * 60 * 60 * 1000);
  const pw2 = fx.reopen(pw1);
  pw2.clean("job-1", [file.path]);

  const view = pw2.getJob("job-1");
  assert.equal(view.receivedAt, T0);
  assert.equal(view.expiresAt, T0 + RETENTION_MS);

  fx.clock.set(T0 + RETENTION_MS);
  assert.throws(() => pw2.undo("job-1"), (err: unknown) => {
    assert.equal((err as PurgeWaveError).code, "EXPIRED");
    return true;
  });
  const report = pw2.reclaim("job-1");
  assert.equal(report.files[0].status, "purged");
});

test("crash mid-reclaim resumes with the original deadline judgment", (t) => {
  const fx = makeFixture();
  t.after(fx.closeAll);
  const files = [fx.makeFile("a.bin"), fx.makeFile("b.bin"), fx.makeFile("c.bin")];
  const paths = files.map((f) => f.path);
  const pw1 = fx.open();
  pw1.clean("job-1", paths);

  fx.clock.set(T0 + RETENTION_MS);
  const plan = new CrashPlan([{ point: "reclaim:removed", after: 1 }]);
  const pw2 = fx.reopen(pw1, plan);
  assert.throws(() => pw2.reclaim("job-1"), SimulatedCrash);

  // clock moves further; resume must reuse the first-received judgment
  fx.clock.advance(60 * 60 * 1000);
  const pw3 = fx.reopen(pw2);
  const report = pw3.reclaim("job-1");
  assert.ok(report.files.every((f) => f.status === "purged"));
  assert.equal(fx.retainedNames().length, 0);
  for (const file of files) {
    assert.equal(fx.exists(file.path), false);
  }
});

test("reclaim result lost before return: retry does not reprocess", (t) => {
  const fx = makeFixture();
  t.after(fx.closeAll);
  const file = fx.makeFile("a.bin");
  const pw1 = fx.open();
  pw1.clean("job-1", [file.path]);

  fx.clock.set(T0 + RETENTION_MS);
  const plan = new CrashPlan([{ point: "reclaim:before-return", after: 1 }]);
  const pw2 = fx.reopen(pw1, plan);
  assert.throws(() => pw2.reclaim("job-1"), SimulatedCrash);

  const pw3 = fx.reopen(pw2);
  const report = pw3.reclaim("job-1");
  assert.equal(report.files[0].status, "purged");
  assert.equal(fx.retainedNames().length, 0);
});

test("reclaim never touches restored files or new files at original paths", (t) => {
  const fx = makeFixture();
  t.after(fx.closeAll);
  const restored = fx.makeFile("restored.bin");
  const occupied = fx.makeFile("occupied.bin");
  const pw = fx.open();
  pw.clean("job-1", [restored.path, occupied.path]);

  const occupant = Buffer.from("post-clean occupant");
  fx.writeFile(occupied.path, occupant);
  const undoReport = pw.undo("job-1");
  assert.equal(undoReport.files.find((f) => f.path === restored.path)?.status, "restored");
  assert.equal(undoReport.files.find((f) => f.path === occupied.path)?.status, "conflict");

  fx.clock.set(T0 + RETENTION_MS);
  const report = pw.reclaim("job-1");
  assert.equal(report.files.find((f) => f.path === restored.path)?.status, "restored");
  assert.equal(report.files.find((f) => f.path === occupied.path)?.status, "purged");

  assert.deepEqual(fx.readFile(restored.path), restored.content, "restored file untouched");
  assert.deepEqual(fx.readFile(occupied.path), occupant, "occupant at original path untouched");
  assert.equal(fx.retainedNames().length, 0);
});

test("reopen sweeps retained content that belongs to no job", (t) => {
  const fx = makeFixture();
  t.after(fx.closeAll);
  const file = fx.makeFile("a.bin");
  const pw1 = fx.open();
  pw1.clean("job-1", [file.path]);
  assert.equal(fx.retainedNames().length, 1);

  writeFileSync(join(fx.storageDir, "retained", "unowned-garbage"), "junk");
  const pw2 = fx.reopen(pw1);
  assert.deepEqual(fx.retainedNames().sort(), [...fx.retainedNames()].filter((n) => n !== "unowned-garbage"));
  assert.equal(fx.retainedNames().includes("unowned-garbage"), false);

  const view = pw2.getJob("job-1");
  assert.equal(view.files[0].status, "cleaned");
});
