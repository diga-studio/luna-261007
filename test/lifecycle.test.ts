import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { PipelineExecutor } from "../src/index";
import { fileSize, makeExecutor, makeTempDir, NODE, sleep, waitStatus, writeScript } from "./helpers";

test("all steps succeed -> Passed, stdout/stderr saved separately with exact bytes", async () => {
  const dir = makeTempDir("passed");
  const executor = makeExecutor(dir);
  const script = writeScript(
    dir,
    "emit.js",
    `process.stdout.write(Buffer.from([0,159,146,150,10]));process.stderr.write("err-bytes\\n");`
  );
  const run = executor.submit(
    {
      stages: [
        {
          name: "Build",
          steps: [
            { name: "compile", command: NODE, args: [script] },
            { name: "package", command: NODE, args: ["-e", "console.log('pkg')"] },
          ],
        },
        {
          name: "Test",
          steps: [{ name: "unit", command: NODE, args: ["-e", "console.log('tests ok')"] }],
        },
      ],
    },
    { logDir: path.join(dir, "logs") }
  );
  await executor.drain();

  const record = executor.getRun(run.id)!;
  assert.equal(record.status, "Passed");
  assert.ok(record.startedAt);
  assert.ok(record.finishedAt);

  const logs = executor.getLogs(run.id)!;
  assert.equal(logs.steps.length, 3);
  const compile = logs.steps[0];
  assert.deepEqual(fs.readFileSync(compile.stdoutPath), Buffer.from([0, 159, 146, 150, 10]));
  assert.equal(fs.readFileSync(compile.stderrPath, "utf8"), "err-bytes\n");
  assert.equal(logs.steps[0].stepName, "compile");
  assert.equal(logs.steps[2].stageName, "Test");
  executor.close();
});

test("nonzero exit -> Failed, later steps and stages never run", async () => {
  const dir = makeTempDir("failed");
  const executor = makeExecutor(dir);
  const marker = path.join(dir, "should-not-exist");
  const run = executor.submit(
    {
      stages: [
        {
          name: "Build",
          steps: [
            { name: "boom", command: NODE, args: ["-e", "process.exit(3)"] },
            { name: "later", command: NODE, args: ["-e", `require("fs").writeFileSync(${JSON.stringify(marker)},"x")`] },
          ],
        },
        { name: "Deploy", steps: [{ name: "deploy", command: NODE, args: ["-e", ""] }] },
      ],
    },
    { logDir: path.join(dir, "logs") }
  );
  await executor.drain();

  const record = executor.getRun(run.id)!;
  assert.equal(record.status, "Failed");
  assert.match(record.detail!, /exited with code 3/);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(executor.getLogs(run.id)!.steps.length, 1);
  executor.close();
});

test("unstartable program -> Failed", async () => {
  const dir = makeTempDir("spawnfail");
  const executor = makeExecutor(dir);
  const run = executor.submit(
    { stages: [{ name: "Build", steps: [{ name: "x", command: "/nonexistent/program-xyz" }] }] },
    { logDir: path.join(dir, "logs") }
  );
  await executor.drain();
  const record = executor.getRun(run.id)!;
  assert.equal(record.status, "Failed");
  assert.match(record.detail!, /failed to start/);
  executor.close();
});

test("queued runs start in submission order; queued cancel is accepted and never starts", async () => {
  const dir = makeTempDir("order");
  const executor = makeExecutor(dir, 1);
  const orderFile = path.join(dir, "order.txt");
  const slow = writeScript(dir, "slow.js", `setTimeout(()=>{},300);`);
  const mark = (tag: string) =>
    `require("fs").appendFileSync(${JSON.stringify(orderFile)},${JSON.stringify(tag)});`;

  const runA = executor.submit(
    { stages: [{ name: "Build", steps: [{ name: "a", command: NODE, args: [slow] }] }] },
    { logDir: path.join(dir, "logs-a") }
  );
  const runB = executor.submit(
    { stages: [{ name: "Build", steps: [{ name: "b", command: NODE, args: ["-e", mark("B")] }] }] },
    { logDir: path.join(dir, "logs-b") }
  );
  const runC = executor.submit(
    { stages: [{ name: "Build", steps: [{ name: "c", command: NODE, args: ["-e", mark("C")] }] }] },
    { logDir: path.join(dir, "logs-c") }
  );

  // B is canceled while still queued behind A.
  await waitStatus(executor, runB.id, "Queued").catch(() => undefined);
  const cancelB = executor.requestCancel(runB.id);
  assert.equal(cancelB.accepted, true);

  await executor.drain();
  assert.equal(executor.getRun(runA.id)!.status, "Passed");
  assert.equal(executor.getRun(runB.id)!.status, "Canceled");
  assert.equal(executor.getRun(runC.id)!.status, "Passed");
  // Canceled run never executed a step: no logs, no "B" in the order file.
  assert.equal(executor.getLogs(runB.id)!.steps.length, 0);
  assert.equal(fs.readFileSync(orderFile, "utf8"), "C");
  executor.close();
});

test("cancel of a terminal run is not accepted", async () => {
  const dir = makeTempDir("terminal");
  const executor = makeExecutor(dir);
  const run = executor.submit(
    { stages: [{ name: "Build", steps: [{ name: "ok", command: NODE, args: ["-e", ""] }] }] },
    { logDir: path.join(dir, "logs") }
  );
  await executor.drain();
  assert.equal(executor.getRun(run.id)!.status, "Passed");
  const result = executor.requestCancel(run.id);
  assert.equal(result.accepted, false);
  assert.equal(result.status, "Passed");
  assert.equal(executor.getRun(run.id)!.status, "Passed");
  executor.close();
});

test("successful step: lingering descendants are stopped before the next step and before Passed", async () => {
  const dir = makeTempDir("lingering");
  const executor = makeExecutor(dir);
  const marker = path.join(dir, "lingering-writes.txt");
  const parent = writeScript(
    dir,
    "parent-exits.js",
    `
    const { spawn } = require("child_process");
    const path = require("path");
    const child = spawn(process.execPath, [path.join(__dirname, "grandchild.js")], {
      stdio: "inherit",
      env: process.env,
    });
    child.on("exit", () => {});
    setTimeout(() => process.exit(0), 100);
    `
  );
  writeScript(
    dir,
    "grandchild.js",
    `
    const fs = require("fs");
    setInterval(() => { fs.appendFileSync(process.env.MARKER, "x"); }, 50);
    setInterval(() => {}, 1000);
    `
  );
  const run = executor.submit(
    {
      stages: [
        {
          name: "Build",
          steps: [
            { name: "spawns-child", command: NODE, args: [parent], env: { MARKER: marker } },
            { name: "next", command: NODE, args: ["-e", ""] },
          ],
        },
      ],
    },
    { logDir: path.join(dir, "logs") }
  );
  await executor.drain();

  assert.equal(executor.getRun(run.id)!.status, "Passed");
  // The descendant was stopped when its parent exited: no more writes.
  const sizeAtTerminal = fileSize(marker);
  await sleep(400);
  assert.equal(fileSize(marker), sizeAtTerminal, "descendant must be stopped after its step exits");
  executor.close();
});
