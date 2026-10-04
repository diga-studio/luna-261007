import { Batch } from "./batch.js";
import { RevisionStore } from "./store.js";
import * as path from "node:path";
import type {
  TemplateContent,
  TemplateRevision,
} from "./types.js";

export * from "./types.js";
export { Batch } from "./batch.js";
export { renderTemplate } from "./substitute.js";

export interface CampaignForgeOptions {
  /** Directory (or file path) used for durable revision storage. */
  storagePath: string;
  /** How many recent revisions stay readable. Defaults to 20. */
  historyWindow?: number;
}

/**
 * CampaignForge entry point: template revision management plus
 * batch DTR parsing. Revisions are persisted locally and survive restarts.
 */
export class CampaignForge {
  private readonly store: RevisionStore;
  private readonly historyWindow: number;
  private readonly batches = new Map<string, Batch>();
  private batchCounter = 0;

  constructor(options: CampaignForgeOptions) {
    this.historyWindow = options.historyWindow ?? 20;
    this.store = new RevisionStore(path.join(options.storagePath, "revisions.json"));
    // Batches do not survive a restart: drop anything outside the read window.
    this.store.prune(this.historyWindow, new Map());
  }

  /**
   * Submit a new revision of a template. The revision takes effect
   * atomically as a whole and gets the next increasing revision number.
   */
  submitRevision(templateId: string, content: TemplateContent): TemplateRevision {
    const revision: TemplateRevision = {
      templateId,
      revision: this.store.latestRevision(templateId) + 1,
      content,
    };
    this.store.append(revision);
    this.store.prune(this.historyWindow, this.collectPins());
    return revision;
  }

  /** Read the most recent revisions (newest first), limited to the history window. */
  readHistory(templateId: string): TemplateRevision[] {
    return this.store.recent(templateId, this.historyWindow);
  }

  /**
   * Start a batch bound to the latest revision of every template
   * in the manifest. Later submissions do not affect this batch.
   */
  startBatch(templateIds: string[]): Batch {
    const bindings = new Map<string, TemplateRevision>();
    for (const templateId of new Set(templateIds)) {
      const latest = this.store.latestRevision(templateId);
      const revision = latest === 0 ? undefined : this.store.get(templateId, latest);
      if (!revision) {
        throw new Error(`template ${templateId} has no revisions`);
      }
      bindings.set(templateId, revision);
    }
    const id = `batch-${++this.batchCounter}`;
    const batch = new Batch({
      id,
      bindings,
      onSettled: (settledId) => this.settleBatch(settledId),
    });
    this.batches.set(id, batch);
    return batch;
  }

  /** Release pins held by a settled batch and prune unpinned old revisions. */
  private settleBatch(id: string): void {
    this.batches.delete(id);
    this.store.prune(this.historyWindow, this.collectPins());
  }

  private collectPins(): Map<string, Set<number>> {
    const pins = new Map<string, Set<number>>();
    for (const batch of this.batches.values()) {
      for (const [templateId, revisions] of batch.pinnedRevisions()) {
        let set = pins.get(templateId);
        if (!set) {
          set = new Set();
          pins.set(templateId, set);
        }
        for (const revision of revisions) {
          set.add(revision);
        }
      }
    }
    return pins;
  }
}
