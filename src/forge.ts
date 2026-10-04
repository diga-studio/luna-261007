import { BatchImpl } from "./batch";
import { RevisionStore } from "./store";
import type { Batch, Template, TemplateRevision } from "./types";

export interface CampaignForgeOptions {
  /** 本地持久化目录 */
  dataDir: string;
  /** 历史读取保留窗口大小，默认 20 */
  retentionWindow?: number;
}

/**
 * CampaignForge 批量 DTR 解析库入口。
 * 模板修订持久化在本地文件中，正常重启后最近 20 个修订仍可读取。
 */
export class CampaignForge {
  private readonly store: RevisionStore;
  private readonly retentionWindow: number;
  private readonly activeBatches = new Set<BatchImpl>();
  private batchCounter = 0;

  constructor(options: CampaignForgeOptions) {
    this.store = new RevisionStore(options.dataDir);
    this.retentionWindow = options.retentionWindow ?? 20;
  }

  /** 提交模板修订，返回递增修订号，整体生效 */
  submitRevision(templateId: string, template: Template): number {
    const revision = this.store.append(templateId, { templateId, revision: 0, template });
    this.pruneTemplate(templateId);
    return revision;
  }

  /** 读取最近 20 个修订（含当前修订），按修订号升序 */
  getHistory(templateId: string): TemplateRevision[] {
    return this.store.latest(templateId, this.retentionWindow);
  }

  /** 启动批次：绑定清单内各模板的最新修订 */
  startBatch(templateIds: string[]): Batch {
    const bindings = new Map<string, TemplateRevision>();
    for (const templateId of templateIds) {
      const head = this.store.headRevision(templateId);
      const record = head > 0 ? this.store.get(templateId, head) : undefined;
      if (record === undefined) {
        throw new Error(`template "${templateId}" has no revisions to bind`);
      }
      bindings.set(templateId, record);
    }
    this.batchCounter += 1;
    const batch = new BatchImpl(`batch-${this.batchCounter}`, bindings, (b) => {
      this.activeBatches.delete(b);
      for (const templateId of templateIds) this.pruneTemplate(templateId);
    });
    this.activeBatches.add(batch);
    return batch;
  }

  /** 释放资源（正常关闭） */
  close(): void {
    this.activeBatches.clear();
  }

  /** 清理窗口外且未被任何活跃批次钉住的旧修订 */
  private pruneTemplate(templateId: string): void {
    const head = this.store.headRevision(templateId);
    const keepFrom = Math.max(1, head - this.retentionWindow + 1);
    const pinned = new Set<number>();
    for (const batch of this.activeBatches) {
      const revision = batch.pins().get(templateId);
      if (revision !== undefined) pinned.add(revision);
    }
    this.store.prune(templateId, keepFrom, pinned);
  }
}
