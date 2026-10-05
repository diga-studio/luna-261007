import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RenderFn, TaskView } from "./types.ts";
import { Store, type TaskRow } from "./store.ts";

export interface LedgerOptions {
  /** Directory holding ledger.sqlite and the images/ subdirectory. */
  dir: string;
}

export class ImageBatchLedger {
  private store: Store;
  private dir: string;
  private imagesDir: string;

  constructor(options: LedgerOptions) {
    this.dir = options.dir;
    this.imagesDir = join(options.dir, "images");
    mkdirSync(this.imagesDir, { recursive: true });
    this.store = new Store(join(options.dir, "ledger.sqlite"));
  }

  close(): void {
    this.store.close();
  }

  submit(_requestId: string, _prompt: string, _count: number): TaskView {
    if (!_requestId) throw new Error("requestId must be non-empty");
    if (!Number.isInteger(_count) || _count <= 0) {
      throw new Error("count must be a positive integer");
    }
    const existing = this.store.getTask(_requestId);
    if (existing) {
      if (existing.prompt !== _prompt || existing.count !== _count) {
        throw new Error(
          `requestId "${_requestId}" already exists with different parameters`
        );
      }
      return this.toView(existing);
    }
    const row: TaskRow = {
      requestId: _requestId,
      prompt: _prompt,
      count: _count,
      status: "queued",
      nextIndex: 0,
      createdAt: Date.now(),
    };
    this.store.insertTask(row);
    return this.toView(row);
  }

  /** Run one queued task to completion or failure. Returns null if none queued. */
  async runNext(_render: RenderFn): Promise<TaskView | null> {
    const task = this.store.nextQueuedTask();
    if (!task) return null;
    this.store.updateStatus(task.requestId, "processing");
    try {
      for (let i = task.nextIndex; i < task.count; i++) {
        const bytes = await _render(task.requestId, i, task.prompt);
        const relPath = join("images", this.imageFileName(task.requestId, i));
        writeFileSync(join(this.dir, relPath), bytes);
        this.store.checkpointImage(task.requestId, i, relPath);
      }
      this.store.updateStatus(task.requestId, "completed");
    } catch {
      this.store.updateStatus(task.requestId, "failed");
    }
    return this.get(task.requestId);
  }

  replay(_requestId: string): TaskView {
    const task = this.store.getTask(_requestId);
    if (!task) throw new Error(`unknown requestId "${_requestId}"`);
    if (task.status === "failed") {
      this.store.updateStatus(_requestId, "queued");
    }
    return this.toView(this.store.getTask(_requestId)!);
  }

  get(_requestId: string): TaskView | null {
    const task = this.store.getTask(_requestId);
    return task ? this.toView(task) : null;
  }

  private imageFileName(requestId: string, index: number): string {
    const key = createHash("sha256").update(requestId).digest("hex").slice(0, 16);
    return `${key}-${index}.img`;
  }

  private toView(task: TaskRow): TaskView {
    const view: TaskView = {
      requestId: task.requestId,
      prompt: task.prompt,
      count: task.count,
      status: task.status,
      completedCount: this.store.countImages(task.requestId),
    };
    if (task.status === "completed") {
      view.imagePaths = this.store
        .listImages(task.requestId)
        .map((img) => join(this.dir, img.path));
    }
    return view;
  }
}
