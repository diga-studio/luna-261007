import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeExecutor, makeTempDir, NODE, sleep, waitStatus, writeScript, fileSize } from "./helpers";

const PARENT_WITH_CHILD = `
const { spawn } = require("child_process");
const path = require("path");
const child = spawn(process.execPath, [path.join(__dirname, "child-writer.js")], {
  stdio: "inherit",
  env: process.env,
});
child.on("exit", () => {});
process.stdout.write("parent-stdout\\n");
process.stderr.write("parent-stderr\\n");
setInterval(() => {}, 1000);
`;

const CHILD_WRITER = `
const fs = require("fs");
setInterval(() => {
  fs.appendFileSync(process.env.MARKER, "x");
}, 50);
setInterval(() => {}, 1000);
`;

// Parent exits 0 as soon as its child is armed; the child ignores SIGTERM
// and lingers, holding the stdout/stderr pipes open.
const EXIT_ZERO_WITH_LINGERING_CHILD = `
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const child = spawn(process.execPath, [path.join(__dirname, "lingering-child.js")], {
  stdio: "inherit",
  env: process.env,
});
child.on("exit", () => {});
const ready = setInterval(() => {
  if (fs.existsSync(process.env.READY)) {
    clearInterval(ready);
    process.exit(0);
  }
}, 20);
setTimeout(() => process.exit(1), 15000);
`;

const LINGERING_CHILD = `
const fs = require("fs");
process.on("SIGTERM", () => {});
fs.writeFileSync(process.env.READY, "ready");
setInterval(() => {
  try { fs.appendFileSync(process.env.MARKER, "y"); } catch {}
}, 50);
setInterval(() => {}, 1000);
`;

test("cancel with live descendants: tree stops, later steps never run, logs freeze at terminal state", async () => {
  const dir = makeTempDir("cancel-tree");
  const executor = makeExecutor(dir);
  const marker = path.join(dir, "descendant-writes.txt");
  const step2Marker = path.join(dir, "step2-ran.txt");
  writeScript(dir, "parent.js", PARENT_WITH_CHILD);
  writeScript(dir, "child-writer.js", CHILD_WRITER);

  const run = executor.submit(
    {
      stages: [
        {
          name: "Build",
          steps: [
            {
              name: "with-descendants",
              command: NODE,
              args: [path.join(dir, "parent.js")],
              env: { MARKER: marker },
            },
            {
              name: "after",
              command: NODE,
              args: ["-e", `require("fs").writeFileSync(${JSON.stringify(step2Marker)},"x")`],
            },
          ],
        },
      ],
    },
    { logDir: path.join(dir, "logs") }
  );

  await waitStatus(executor, run.id, "Running");
  // Let the descendant produce some writes first.
  await sleep(300);
  assert.ok(fs.existsSync(marker), "descendant should have written before cancel");
  const sizeBeforeCancel = fileSize(marker);

  const cancel1 = executor.requestCancel(run.id);
  assert.equal(cancel1.accepted, true);
  // Repeated cancel while canceling: accepted again, no duplicate cleanup.
  const cancel2 = executor.requestCancel(run.id);
  assert.equal(cancel2.accepted, true);

  await executor.drain();

  const record = executor.getRun(run.id)!;
  assert.equal(record.status, "Canceled");
  assert.equal(fs.existsSync(step2Marker), false, "later step must not run");

  const logs = executor.getLogs(run.id)!;
  assert.equal(logs.steps.length, 1, "only the canceled step has logs");
  const stdoutPath = logs.steps[0].stdoutPath;
  const stderrPath = logs.steps[0].stderrPath;
  assert.equal(fs.readFileSync(stdoutPath, "utf8"), "parent-stdout\n");
  assert.equal(fs.readFileSync(stderrPath, "utf8"), "parent-stderr\n");

  // After the terminal state: descendants are dead (marker frozen) and
  // logs no longer grow.
  const markerAtTerminal = fileSize(marker);
  const stdoutAtTerminal = fileSize(stdoutPath);
  const stderrAtTerminal = fileSize(stderrPath);
  assert.ok(markerAtTerminal >= sizeBeforeCancel);
  await sleep(600);
  assert.equal(fileSize(marker), markerAtTerminal, "descendant must be stopped");
  assert.equal(fileSize(stdoutPath), stdoutAtTerminal, "stdout log must not grow");
  assert.equal(fileSize(stderrPath), stderrAtTerminal, "stderr log must not grow");

  // Terminal state is stable and a late cancel is rejected.
  assert.equal(executor.getRun(run.id)!.status, "Canceled");
  const lateCancel = executor.requestCancel(run.id);
  assert.equal(lateCancel.accepted, false);
  assert.equal(lateCancel.status, "Canceled");
  executor.close();
});

test("step exit racing with cancel: accepted cancel forces Canceled even when the step exited 0", async () => {
  const dir = makeTempDir("cancel-race");
  const executor = makeExecutor(dir);
  const marker = path.join(dir, "lingering-writes.txt");
  const ready = path.join(dir, "ready.txt");
  const step2Marker = path.join(dir, "step2-ran.txt");
  writeScript(dir, "exit0.js", EXIT_ZERO_WITH_LINGERING_CHILD);
  writeScript(dir, "lingering-child.js", LINGERING_CHILD);

  const run = executor.submit(
    {
      stages: [
        {
          name: "Test",
          steps: [
            {
              name: "exit-zero",
              command: NODE,
              args: [path.join(dir, "exit0.js")],
              env: { MARKER: marker, READY: ready },
            },
            {
              name: "after",
              command: NODE,
              args: ["-e", `require("fs").writeFileSync(${JSON.stringify(step2Marker)},"x")`],
            },
          ],
        },
      ],
    },
    { logDir: path.join(dir, "logs") }
  );

  await waitStatus(executor, run.id, "Running");
  // The main program exits 0 almost immediately; the runner is then busy
  // terminating the lingering descendant (which ignores SIGTERM for the
  // full grace period). Cancel lands inside that window.
  await sleep(200);
  const cancel = executor.requestCancel(run.id);
  assert.equal(cancel.accepted, true);

  await executor.drain();

  // Cancellation wins over the successful exit notification.
  const record = executor.getRun(run.id)!;
  assert.equal(record.status, "Canceled");
  assert.equal(fs.existsSync(step2Marker), false, "later step must not run");

  // The lingering descendant was stopped (SIGKILL after the grace period):
  // its marker file stops growing.
  const logs = executor.getLogs(run.id)!;
  const stdoutPath = logs.steps[0].stdoutPath;
  const markerAtTerminal = fs.existsSync(marker) ? fileSize(marker) : 0;
  const stdoutAtTerminal = fileSize(stdoutPath);
  await sleep(600);
  const markerAfter = fs.existsSync(marker) ? fileSize(marker) : 0;
  assert.equal(markerAfter, markerAtTerminal, "lingering descendant must be stopped");
  assert.equal(fileSize(stdoutPath), stdoutAtTerminal, "log must not grow after terminal state");
  assert.equal(executor.getRun(run.id)!.status, "Canceled");
  executor.close();
});
