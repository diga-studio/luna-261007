import * as fs from "node:fs";
import * as path from "node:path";
import type { TemplateRevision } from "./types.js";

type StoreData = Record<string, TemplateRevision[]>;

/**
 * Durable persistence for template revisions.
 * Keeps every revision that is either inside the recent read window
 * or still pinned by a live batch.
 */
export class RevisionStore {
  private readonly filePath: string;
  private readonly byTemplate: Map<string, Map<number, TemplateRevision>>;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.byTemplate = new Map();
    this.load();
  }

  private load(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch {
      return;
    }
    const data = JSON.parse(raw) as StoreData;
    for (const templateId of Object.keys(data)) {
      const revisions = new Map<number, TemplateRevision>();
      for (const revision of data[templateId]) {
        revisions.set(revision.revision, revision);
      }
      this.byTemplate.set(templateId, revisions);
    }
  }

  private persist(): void {
    const data: StoreData = {};
    for (const [templateId, revisions] of this.byTemplate) {
      data[templateId] = [...revisions.values()].sort((a, b) => a.revision - b.revision);
    }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(data), "utf8");
    fs.renameSync(tmpPath, this.filePath);
  }

  /** Latest revision number for a template, or 0 when none exists. */
  latestRevision(templateId: string): number {
    const revisions = this.byTemplate.get(templateId);
    if (!revisions || revisions.size === 0) {
      return 0;
    }
    return Math.max(...revisions.keys());
  }

  /** Append a new revision (revision number must be latest + 1) and persist. */
  append(revision: TemplateRevision): void {
    let revisions = this.byTemplate.get(revision.templateId);
    if (!revisions) {
      revisions = new Map();
      this.byTemplate.set(revision.templateId, revisions);
    }
    if (revision.revision !== this.latestRevision(revision.templateId) + 1) {
      throw new Error(
        `revision ${revision.revision} is not the next revision for template ${revision.templateId}`,
      );
    }
    revisions.set(revision.revision, revision);
    this.persist();
  }

  /** Read a specific revision, or undefined when it has been pruned. */
  get(templateId: string, revision: number): TemplateRevision | undefined {
    return this.byTemplate.get(templateId)?.get(revision);
  }

  /** Most recent `limit` revisions of a template, newest first. */
  recent(templateId: string, limit: number): TemplateRevision[] {
    const revisions = this.byTemplate.get(templateId);
    if (!revisions) {
      return [];
    }
    return [...revisions.values()]
      .sort((a, b) => b.revision - a.revision)
      .slice(0, limit);
  }

  /**
   * Drop revisions that are neither within the newest `keep` revisions
   * of their template nor pinned by a live batch.
   */
  prune(keep: number, pinned: ReadonlyMap<string, ReadonlySet<number>>): void {
    for (const [templateId, revisions] of this.byTemplate) {
      const sorted = [...revisions.keys()].sort((a, b) => b - a);
      const kept = new Set(sorted.slice(0, keep));
      const pinnedForTemplate = pinned.get(templateId);
      for (const revision of sorted) {
        if (kept.has(revision)) {
          continue;
        }
        if (pinnedForTemplate && pinnedForTemplate.has(revision)) {
          continue;
        }
        revisions.delete(revision);
      }
    }
    this.persist();
  }
}
