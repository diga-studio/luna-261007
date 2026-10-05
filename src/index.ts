export type NodeId = string;
export type VersionId = string;
export type BatchId = string;

export type Percentage = 10 | 25 | 50 | 100;

export type Renderer = (nodeId: NodeId, text: string) => Promise<string>;

export interface TemplateStoreOptions {
  baselineText: string;
}

interface VersionRecord {
  id: VersionId;
  text: string;
}

interface BatchRecord {
  id: BatchId;
  versionId: VersionId;
  members: Set<NodeId>;
  withdrawn: boolean;
}

const VALID_PERCENTAGES: readonly number[] = [10, 25, 50, 100];

function hashNodeId(nodeId: NodeId): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < nodeId.length; index += 1) {
    hash ^= nodeId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function selectMembers(
  nodeIds: readonly NodeId[],
  percentage: Percentage
): NodeId[] {
  const unique = [...new Set(nodeIds)];
  const ranked = unique
    .map((nodeId) => ({ nodeId, hash: hashNodeId(nodeId) }))
    .sort((a, b) => a.hash - b.hash || (a.nodeId < b.nodeId ? -1 : 1));
  const count = Math.ceil((unique.length * percentage) / 100);
  return ranked.slice(0, count).map((entry) => entry.nodeId);
}

export class GrayTemplateStore {
  private readonly baselineText: string;
  private readonly versions = new Map<VersionId, VersionRecord>();
  private readonly batches = new Map<BatchId, BatchRecord>();
  private versionCounter = 0;

  constructor(options: TemplateStoreOptions) {
    this.baselineText = options.baselineText;
  }

  publish(text: string): VersionId {
    this.versionCounter += 1;
    const id: VersionId = `v${this.versionCounter}`;
    this.versions.set(id, { id, text });
    return id;
  }

  rollout(
    batchId: BatchId,
    versionId: VersionId,
    nodeIds: readonly NodeId[],
    percentage: Percentage
  ): NodeId[] {
    const existing = this.batches.get(batchId);
    if (existing) {
      return [...existing.members];
    }
    if (!VALID_PERCENTAGES.includes(percentage)) {
      throw new Error(`invalid percentage: ${percentage}`);
    }
    if (!this.versions.has(versionId)) {
      throw new Error(`unknown versionId: ${versionId}`);
    }
    const members = selectMembers(nodeIds, percentage);
    this.batches.set(batchId, {
      id: batchId,
      versionId,
      members: new Set(members),
      withdrawn: false,
    });
    return members;
  }

  withdraw(batchId: BatchId): void {
    const batch = this.batches.get(batchId);
    if (!batch) {
      throw new Error(`unknown batchId: ${batchId}`);
    }
    batch.withdrawn = true;
  }

  async render(
    nodeIds: readonly NodeId[],
    renderer: Renderer
  ): Promise<Map<NodeId, string>> {
    const entries = await Promise.all(
      nodeIds.map(async (nodeId) => {
        const text = this.effectiveText(nodeId);
        const rendered = await renderer(nodeId, text);
        return [nodeId, rendered] as const;
      })
    );
    return new Map(entries);
  }

  private effectiveText(nodeId: NodeId): string {
    let versionId: VersionId | undefined;
    for (const batch of this.batches.values()) {
      if (!batch.withdrawn && batch.members.has(nodeId)) {
        versionId = batch.versionId;
      }
    }
    if (versionId === undefined) {
      return this.baselineText;
    }
    return this.versions.get(versionId)!.text;
  }
}
