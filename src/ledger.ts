import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Store, TaskRow } from "./store";
import { ConflictError, RenderFn, TaskView } from "./types";

/**
 * Persistent ledger for image-generation batches.
 *
 * Layout inside the storage directory:
 *   <dir>/ledger.db          SQLite metadata (tasks + image checkpoints)
 *   <dir>/images/<file>      one file per generated image
 */
export class ImageLedger {
  private readonly imagesDir: string;
  private readonly store: Store;
  private tmpCounter = 0;

  constructor(dir: string) {
    const root = resolve(dir);
    this.imagesDir = join(root, "images");
    mkdirSync(this.imagesDir, { recursive: true });
    this.store = new Store(join(root, "ledger.db"));
  }

  close(): void {
    this.store.close();
  }

  submit(requestId: string, prompt: string, count: number): TaskView {
    if (typeof requestId !== "string" || requestId.length === 0) {
      throw new Error("requestId must be a non-empty string");
    }
    if (!Number.isInteger(count) || count < 1) {
      throw new Error("count must be a positive integer");
    }
    const existing = this.store.getTask(requestId);
    if (existing !== undefined) {
      if (existing.prompt !== prompt || existing.count !== count) {
        throw new ConflictError(
          `requestId ${requestId} already exists with different parameters`
        );
      }
      return this.toView(existing);
    }
    this.store.insertTask(requestId, prompt, count);
    return this.toView(this.mustGet(requestId));
  }

  async runNext(render: RenderFn): Promise<TaskView | undefined> {
    const task = this.store.nextQueuedTask();
    if (task === undefined) {
      return undefined;
    }
    this.store.setStatus(task.requestId, "processing");
    try {
      for (let index = task.nextIndex; index < task.count; index += 1) {
        const bytes = await render(task.requestId, index, task.prompt);
        const fileName = this.persistImage(task.requestId, index, bytes);
        this.store.checkpointImage(task.requestId, index, fileName, index);
      }
    } catch (err) {
      this.store.setStatus(task.requestId, "failed");
      return this.toView(this.mustGet(task.requestId));
    }
    this.store.setStatus(task.requestId, "completed");
    return this.toView(this.mustGet(task.requestId));
  }

  replay(requestId: string): TaskView {
    const task = this.mustGet(requestId);
    if (task.status === "failed") {
      this.store.setStatus(requestId, "queued");
    }
    return this.toView(this.mustGet(requestId));
  }

  get(requestId: string): TaskView | undefined {
    const task = this.store.getTask(requestId);
    return task === undefined ? undefined : this.toView(task);
  }

  private mustGet(requestId: string): TaskRow {
    const task = this.store.getTask(requestId);
    if (task === undefined) {
      throw new Error(`unknown requestId: ${requestId}`);
    }
    return task;
  }

  private toView(task: TaskRow): TaskView {
    const view: TaskView = {
      requestId: task.requestId,
      prompt: task.prompt,
      count: task.count,
      status: task.status,
      completedCount: task.nextIndex,
    };
    if (task.status === "completed") {
      view.imagePaths = this.store
        .imageFileNames(task.requestId)
        .map((fileName) => join(this.imagesDir, fileName));
    }
    return view;
  }

  /** Write image bytes atomically; returns the stored file name. */
  private persistImage(requestId: string, index: number, bytes: Uint8Array): string {
    const fileName = `${encodeURIComponent(requestId)}-${index}.bin`;
    const finalPath = join(this.imagesDir, fileName);
    this.tmpCounter += 1;
    const tmpPath = `${finalPath}.tmp-${Date.now()}-${this.tmpCounter}`;
    writeFileSync(tmpPath, bytes);
    renameSync(tmpPath, finalPath);
    return fileName;
  }
}
