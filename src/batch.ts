import type {
  BatchState,
  PageInput,
  PageResult,
  TemplateRevision,
} from "./types.js";
import { renderTemplate } from "./substitute.js";

export interface BatchOptions {
  id: string;
  /** Revisions bound at batch start: templateId -> pinned revision. */
  bindings: ReadonlyMap<string, TemplateRevision>;
  /** Called when the batch ends (completed or cancelled) to release pins. */
  onSettled: (id: string) => void;
}

/**
 * A parse batch bound to a fixed set of template revisions.
 * Pages are pushed asynchronously; results are delivered in input order
 * as an async iterable, without waiting for end of input.
 */
export class Batch {
  readonly id: string;
  private readonly options: BatchOptions;
  private readonly queue: Array<{ sequence: number; page: PageInput }> = [];
  private nextSequence = 0;
  private inputEnded = false;
  private cancelled = false;
  private completed = false;
  private settled = false;
  private consumed = false;
  private wake: (() => void) | null = null;

  constructor(options: BatchOptions) {
    this.id = options.id;
    this.options = options;
  }

  get state(): BatchState {
    if (this.cancelled) {
      return "cancelled";
    }
    if (this.completed) {
      return "completed";
    }
    return "active";
  }

  /** Revisions this batch keeps alive. */
  pinnedRevisions(): ReadonlyMap<string, ReadonlySet<number>> {
    const pinned = new Map<string, ReadonlySet<number>>();
    if (this.settled) {
      return pinned;
    }
    for (const [templateId, revision] of this.options.bindings) {
      pinned.set(templateId, new Set([revision.revision]));
    }
    return pinned;
  }

  /** Submit one page. Only allowed while active; template must be in the manifest. */
  submit(page: PageInput): void {
    if (this.cancelled) {
      throw new Error(`batch ${this.id} is cancelled`);
    }
    if (this.inputEnded) {
      throw new Error(`batch ${this.id} no longer accepts pages`);
    }
    if (!this.options.bindings.has(page.templateId)) {
      throw new Error(
        `template ${page.templateId} is not in the manifest of batch ${this.id}`,
      );
    }
    this.queue.push({ sequence: this.nextSequence++, page });
    this.notify();
  }

  /** Signal end of input. The result stream ends after all queued pages are delivered. */
  finish(): void {
    if (this.cancelled || this.inputEnded) {
      return;
    }
    this.inputEnded = true;
    this.notify();
  }

  /**
   * Cancel the batch. Resolves when cancellation is complete;
   * afterwards no further results are delivered.
   */
  cancel(): Promise<void> {
    if (!this.settled) {
      this.cancelled = true;
      this.queue.length = 0;
      this.notify();
      this.settle();
    }
    return Promise.resolve();
  }

  /** Results in input order, as they become available. */
  results(): AsyncIterable<PageResult> {
    if (this.consumed) {
      throw new Error(`batch ${this.id} results are already being consumed`);
    }
    this.consumed = true;
    return this.iterate();
  }

  private async *iterate(): AsyncIterable<PageResult> {
    for (;;) {
      if (this.cancelled) {
        return;
      }
      const item = this.queue.shift();
      if (item) {
        const binding = this.options.bindings.get(item.page.templateId);
        if (!binding) {
          throw new Error(
            `template ${item.page.templateId} is not in the manifest of batch ${this.id}`,
          );
        }
        yield {
          sequence: item.sequence,
          templateId: item.page.templateId,
          revision: binding.revision,
          output: renderTemplate(binding.content, item.page.params),
        };
        continue;
      }
      if (this.inputEnded) {
        this.completed = true;
        this.settle();
        return;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  private settle(): void {
    if (!this.settled) {
      this.settled = true;
      this.options.onSettled(this.id);
    }
  }
}
