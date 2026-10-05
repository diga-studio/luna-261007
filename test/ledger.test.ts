import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImageBatchLedger } from "../src/index.ts";
import type { RenderFn } from "../src/index.ts";

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "ledger-test-"));
}

function readBytes(path: string): Uint8Array {
  return Uint8Array.from(readFileSync(path));
}

/** Render that returns different bytes on every call (exposes erroneous re-renders). */
function varyingRender(calls: Array<[string, number]>): RenderFn {
  let counter = 0;
  return async (requestId, index) => {
    calls.push([requestId, index]);
    counter += 1;
    return new Uint8Array([index, counter, 0xaa]);
  };
}

test("completed batch: resubmit + rerun adds no render calls or second batch", async () => {
  const dir = makeDir();
  try {
    const ledger = new ImageBatchLedger({ dir });
    const calls: Array<[string, number]> = [];
    const render = varyingRender(calls);

    const submitted = ledger.submit("req-1", "branded prompt", 3);
    assert.equal(submitted.status, "queued");
    assert.equal(submitted.imagePaths, undefined);

    const done = await ledger.runNext(render);
    assert.equal(done!.status, "completed");
    assert.equal(done!.imagePaths!.length, 3);
    assert.equal(calls.length, 3);
    const firstBytes = done!.imagePaths!.map(readBytes);

    // Resubmit identical request: returns original task, no state change.
    const again = ledger.submit("req-1", "branded prompt", 3);
    assert.equal(again.status, "completed");
    assert.deepEqual(again.imagePaths, done!.imagePaths);

    // Running again: nothing queued, no new render calls.
    assert.equal(await ledger.runNext(render), null);
    assert.equal(calls.length, 3);

    // No second batch on disk: still exactly 3 image files, same bytes.
    assert.equal(readdirSync(join(dir, "images")).length, 3);
    done!.imagePaths!.forEach((p, i) => {
      assert.deepEqual(readBytes(p), firstBytes[i]);
    });
    ledger.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("submit with different params is rejected and does not overwrite", async () => {
  const dir = makeDir();
  try {
    const ledger = new ImageBatchLedger({ dir });
    ledger.submit("req-1", "prompt-a", 2);
    assert.throws(() => ledger.submit("req-1", "prompt-b", 2), /different parameters/);
    assert.throws(() => ledger.submit("req-1", "prompt-a", 5), /different parameters/);
    const task = ledger.get("req-1")!;
    assert.equal(task.prompt, "prompt-a");
    assert.equal(task.count, 2);
    assert.equal(task.status, "queued");

    // Same params under a different requestId is a separate batch.
    const other = ledger.submit("req-2", "prompt-a", 2);
    assert.equal(other.status, "queued");
    ledger.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mid-batch failure: stays failed, -> replay generates only the rest", async () => {
  const dir = makeDir();
  try {
    const ledger = new ImageBatchLedger({ dir });
    ledger.submit("req-1", "branded prompt", 4);

    const calls: Array<[string, number]> = [];
    let counter = 0;
    let boomUsed = false;
    const flaky: RenderFn = async (requestId, index) => {
      calls.push([requestId, index]);
      counter += 1;
      if (index === 2 && !boomUsed) {
        boomUsed = true;
        throw new Error("render boom");
      }
      return new Uint8Array([index, counter, 0xbb]); // bytes differ per call
    };

    const failed = await ledger.runNext(flaky);
    assert.equal(failed!.status, "failed");
    assert.equal(failed!.completedCount, 2);
    assert.equal(failed!.imagePaths, undefined); // partial batch not exposed
    assert.deepEqual(calls.map(([, i]) => i), [0, 1, 2]);

    // Resubmit does not auto-rerun; still failed, nothing queued.
    ledger.submit("req-1", "branded prompt", 4);
    assert.equal(ledger.get("req-1")!.status, "failed");
    assert.equal(await ledger.runNext(flaky), null);
    assert.equal(calls.length, 3);

    // Replay requeues; only remaining images are generated.
    const replayed = ledger.replay("req-1");
    assert.equal(replayed.status, "queued");
    const done = await ledger.runNext(flaky);
    assert.equal(done!.status, "completed");
    assert.deepEqual(calls.map(([, i]) => i), [0, 1, 2, 2, 3]);

    // Checkpointed images kept their original bytes (not re-rendered).
    const paths = done!.imagePaths!;
    assert.deepEqual(readBytes(paths[0]!), new Uint8Array([0, 1, 0xbb]));
    assert.deepEqual(readBytes(paths[1]!), new Uint8Array([1, 2, 0xbb]));
    assert.deepEqual(readBytes(paths[2]!), new Uint8Array([2, 4, 0xbb]));
    assert.deepEqual(readBytes(paths[3]!), new Uint8Array([3, 5, 0xbb]));
    ledger.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("replay on queued/completed tasks is a no-op", async () => {
  const dir = makeDir();
  try {
    const ledger = new ImageBatchLedger({ dir });
    ledger.submit("req-1", "p", 1);
    ledger.submit("req-2", "p", 1);

    // Replay of a queued task changes nothing and runs nothing extra.
    assert.equal(ledger.replay("req-1").status, "queued");
    const calls: Array<[string, number]> = [];
    const render = varyingRender(calls);
    await ledger.runNext(render); // runs req-1 (oldest first)
    assert.deepEqual(calls, [["req-1", 0]]);

    // Replay of a completed task does not requeue it.
    assert.equal(ledger.replay("req-1").status, "completed");
    await ledger.runNext(render); // runs req-2
    assert.deepEqual(calls, [["req-1", 0], ["req-2", 0]]);
    assert.equal(await ledger.runNext(render), null);

    assert.throws(() => ledger.replay("nope"), /unknown requestId/);
    ledger.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reopening the same dir preserves state and byte-exact images", async () => {
  const dir = makeDir();
  try {
    const ledger = new ImageBatchLedger({ dir });
    ledger.submit("req-1", "p", 2);
    ledger.submit("req-2", "p", 1);
    const calls: Array<[string, number]> = [];
    const done = await ledger.runNext(varyingRender(calls));
    const bytes = done!.imagePaths!.map(readBytes);
    ledger.close();

    // Reopen: completed batch intact, queued task still pending and runnable.
    const reopened = new ImageBatchLedger({ dir });
    const again = reopened.get("req-1")!;
    assert.equal(again.status, "completed");
    again.imagePaths!.forEach((p, i) => assert.deepEqual(readBytes(p), bytes[i]!));
    assert.equal(reopened.get("req-2")!.status, "queued");
    const second = await reopened.runNext(varyingRender(calls));
    assert.equal(second!.requestId, "req-2");
    assert.equal(second!.status, "completed");
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
