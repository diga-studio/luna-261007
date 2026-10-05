export type TaskStatus = "queued" | "processing" | "completed" | "failed";

export interface TaskView {
  requestId: string;
  prompt: string;
  count: number;
  status: TaskStatus;
  /** Number of images durably checkpointed so far. */
  completedCount: number;
  /** Absolute image paths; only present when status is "completed". */
  imagePaths?: string[];
}

export type RenderFn = (
  requestId: string,
  index: number,
  prompt: string
) => Promise<Uint8Array>;

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}
