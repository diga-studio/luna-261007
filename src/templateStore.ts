import { createHash } from "node:crypto";
import type { BatchRecord, Percentage, Renderer } from "./types.js";

const VALID_PERCENTAGES: readonly Percentage[] = [10, 25, 50, 100];

function rankKey(nodeId: string): string {
  return createHash("sha256").update(nodeId, "utf8").digest("hex");
}

export class TemplateStore {
  private readonly baselineText: string;
  private readonly versions = new Map<string, string>();
  private readonly batches = new Map<string, BatchRecord>();
  private versionSeq = 0;
  private batchSeq = 0;

  constructor(baselineText: string) {
    this.baselineText = baselineText;
  }

  publish(text: string): string {
    this.versionSeq += 1;
    const versionId = `v${this.versionSeq}`;
    this.versions.set(versionId, text);
    return versionId;
  }

  rollout(
    batchId: string,
    versionId: string,
    nodeIds: readonly string[],
    percentage: Percentage,
  ): string[] {
    const candidates = [...new Set(nodeIds)].sort();
    const existing = this.batches.get(batchId);
    if (existing) {
      const sameRequest =
        existing.versionId === versionId &&
        existing.percentage === percentage &&
        existing.candidates.length === candidates.length &&
        existing.candidates.every((id, i) => id === candidates[i]);
      if (!sameRequest) {
        throw new Error(
          `batchId "${batchId}" already exists with different parameters`,
        );
      }
      return [...existing.members].sort();
    }
    if (!VALID_PERCENTAGES.includes(percentage)) {
      throw new Error(`invalid percentage: ${percentage}`);
    }
    if (!this.versions.has(versionId)) {
      throw new Error(`unknown versionId: ${versionId}`);
    }
    const count = Math.ceil((candidates.length * percentage) / 100);
    const members = candidates
      .map((nodeId) => ({ nodeId, key: rankKey(nodeId) }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .slice(0, count)
      .map((entry) => entry.nodeId)
      .sort();
    this.batchSeq += 1;
    this.batches.set(batchId, {
      batchId,
      versionId,
      percentage,
      candidates,
      members: new Set(members),
      createdSeq: this.batchSeq,
      withdrawn: false,
    });
    return members;
  }

  withdraw(batchId: string): void {
    const batch = this.batches.get(batchId);
    if (batch) {
      batch.withdrawn = true;
    }
  }

  async render(
    nodeIds: readonly string[],
    renderer: Renderer,
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const entries = await Promise.all(
      nodeIds.map(async (nodeId) => {
        const text = this.effectiveText(nodeId);
        return [nodeId, await renderer(nodeId, text)] as const;
      }),
    );
    for (const [nodeId, rendered] of entries) {
      result.set(nodeId, rendered);
    }
    return result;
  }

  private effectiveText(nodeId: string): string {
    let best: BatchRecord | undefined;
    for (const batch of this.batches.values()) {
      if (batch.withdrawn || !batch.members.has(nodeId)) {
        continue;
      }
      if (!best || batch.createdSeq > best.createdSeq) {
        best = batch;
      }
    }
    if (!best) {
      return this.baselineText;
    }
    const text = this.versions.get(best.versionId);
    if (text === undefined) {
      throw new Error(`missing version: ${best.versionId}`);
    }
    return text;
  }
}
