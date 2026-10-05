import { deepEqual, equal, ok, throws } from "node:assert";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ImageLedger } from "../src/ledger";
import { ConflictError, RenderFn } from "../src/types";

interface RenderCall {
  requestId: string;
  index: number;
  prompt: string;
}

/**
 * Render stub: every invocation returns different bytes (a global call
 * counter is embedded), so an erroneous whole-batch rerun is observable
 * as changed bytes of previously checkpointed images.
 */
function makeRender(failAtIndexes: Set<number> = new Set()): {
  render: RenderFn;
  calls: RenderCall[];
} {
  const calls: RenderCall[] = [];
  let sequence = 0;
  const render: RenderFn = async (requestId, index, prompt) => {
    calls.push({ requestId, index, prompt });
    if (failAtIndexes.has(index)) {
      throw new Error(`render failed at index ${index}`);
    }
    sequence += 1;
    return new Uint8Array(
      Buffer.from(`${requestId}|${index}|call#${sequence}`, "utf8")
    );
  };
  return { render, calls };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "ledger-test-"));
}

function imageFiles(dir: string): string[] {
  return readdirSync(join(dir, "images")).filter((name) => !name.includes(".tmp-"));
}

test("resubmitting a completed batch and rerunning adds no render calls or second batch", async () => {
  const dir = tempDir();
  const ledger = new ImageLedger(dir);
  const { render, calls } = makeRender();

  const submitted = ledger.submit("req-1", "brand prompt", 3);
  equal(submitted.status, "queued");
  equal(submitted.imagePaths, undefined);

  const done = await ledger.runNext(render);
  equal(done?.status, "completed");
  equal(calls.length, 3);
  deepEqual(
    calls.map((c) => c.index),
    [0, 1, 2]
  );
  equal(imageFiles(dir).length, 3);

  // Idempotent resubmit: same task, no state change.
  const again = ledger.submit("req-1", "brand prompt", 3);
  equal(again.status, "completed");
  equal(again.imagePaths?.length, 3);

  // Rerunning finds no queued task and renders nothing.
  const rerun = await ledger.runNext(render);
  equal(rerun, undefined);
  equal(calls.length, 3);
  equal(imageFiles(dir).length, 3);

  // Same requestId with different parameters is rejected, original intact.
  throws(() => ledger.submit("req-1", "brand prompt", 4), ConflictError);
  throws(() => ledger.submit("req-1", "other prompt", 3), ConflictError);
  equal(ledger.get("req-1")?.status, "completed");
  equal(ledger.get("req-1")?.count, 3);

  // Same parameters under a different requestId form a separate batch.
  ledger.submit("req-2", "brand prompt", 3);
  const second = await ledger.runNext(render);
  equal(second?.status, "completed");
  equal(calls.length, 6);
  equal(imageFiles(dir).length, 6);

  ledger.close();
});

test("mid-batch failure keeps checkpoints; replay renders only the remainder", async () => {
  const dir = tempDir();
  const ledger = new ImageLedger(dir);
  const { render, calls } = makeRender(new Set([2]));

  ledger.submit("req-fail", "prompt", 4);
  const failed = await ledger.runNext(render);
  equal(failed?.status, "failed");
  equal(failed?.completedCount, 2);
  equal(failed?.imagePaths, undefined);
  equal(calls.length, 3); // indexes 0, 1, then the failing 2

  // Resubmitting must not silently rerun anything.
  const resubmitted = ledger.submit("req-fail", "prompt", 4);
  equal(resubmitted.status, "failed");
  const noop = await ledger.runNext(makeRender().render);
  equal(noop, undefined);
  equal(calls.length, 3);

  // Snapshot checkpointed bytes of images 0 and 1.
  const imagesDir = join(dir, "images");
  const before0 = readFileSync(join(imagesDir, imageFiles(dir).sort()[0]));
  const before1 = readFileSync(join(imagesDir, imageFiles(dir).sort()[1]));
  equal(imageFiles(dir).length, 2);

  // Replay requeues; only indexes 2 and 3 are rendered now.
  const replayed = ledger.replay("req-fail");
  equal(replayed.status, "queued");
  const { render: render2, calls: calls2 } = makeRender();
  const done = await ledger.runNext(render2);
  equal(done?.status, "completed");
  deepEqual(
    calls2.map((c) => c.index),
    [2, 3]
  );

  // Previously checkpointed images keep their original bytes.
  const view = ledger.get("req-fail");
  equal(view?.status, "completed");
  equal(view?.imagePaths?.length, 4);
  deepEqual(readFileSync(view!.imagePaths![0]), before0);
  deepEqual(readFileSync(view!.imagePaths![1]), before1);

  // Replaying a completed task is a no-op; nothing reruns.
  ledger.replay("req-fail");
  equal(await ledger.runNext(render2), undefined);
  equal(calls2.length, 2);

  ledger.close();
});

test("replaying a queued or processing task causes no extra execution", async () => {
  const dir = tempDir();
  const ledger = new ImageLedger(dir);

  ledger.submit("req-q", "prompt", 2);
  const queued = ledger.replay("req-q");
  equal(queued.status, "queued");

  // Replay from inside the render callback: the task is "processing"
  // at that moment and the replay must be a no-op.
  const { render, calls } = makeRender();
  const reentrant: RenderFn = async (requestId, index, prompt) => {
    if (index === 0) {
      ledger.replay(requestId);
    }
    return render(requestId, index, prompt);
  };
  const done = await ledger.runNext(reentrant);
  equal(done?.status, "completed");
  equal(calls.length, 2);
  equal(await ledger.runNext(render), undefined);
  equal(calls.length, 2);

  ledger.close();
});

test("completed batch is byte-identical after reopening the storage directory", async () => {
  const dir = tempDir();
  const ledger = new ImageLedger(dir);
  const { render } = makeRender();

  ledger.submit("req-persist", "prompt", 3);
  await ledger.runNext(render);
  const before = ledger.get("req-persist")!.imagePaths!.map((p) =>
    readFileSync(p)
  );
  ledger.close();

  const reopened = new ImageLedger(dir);
  const view = reopened.get("req-persist");
  equal(view?.status, "completed");
  equal(view?.imagePaths?.length, 3);
  view!.imagePaths!.forEach((p, i) => deepEqual(readFileSync(p), before[i]));

  // A failed task stays failed across reopen and still needs explicit replay.
  reopened.submit("req-stuck", "prompt", 2);
  const { render: flaky } = makeRender(new Set([0]));
  await reopened.runNext(flaky);
  equal(reopened.get("req-stuck")?.status, "failed");
  reopened.close();

  const again = new ImageLedger(dir);
  equal(again.get("req-stuck")?.status, "failed");
  again.replay("req-stuck");
  const { render: ok2, calls: calls2 } = makeRender();
  const done = await again.runNext(ok2);
  equal(done?.status, "completed");
  deepEqual(
    calls2.map((c) => c.index),
    [0, 1]
  );
  again.close();
});
