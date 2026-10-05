import { chainStep, hashEvent, recordKey, ZERO_HEAD } from "./chain.js";
import { computeRoot, leafToData, locateKey, proveInclusion } from "./merkle.js";
import { Storage } from "./storage.js";
import type { DirectoryLeaf } from "./merkle.js";
import type {
  Credential,
  CustodyReport,
  EventInput,
  ReportEvent,
  ReportProof,
} from "./types.js";

const CREDENTIAL_MAGIC = Buffer.from("EC1", "utf8");
const CREDENTIAL_LENGTH = 3 + 8 + 32;

/** 证据保管链账册。 */
export class Ledger {
  private storage: Storage;
  private isSealed: boolean;
  private credential: Credential | null = null;

  private constructor(storage: Storage, sealed: boolean) {
    this.storage = storage;
    this.isSealed = sealed;
  }

  /** 打开（不存在则创建）账册文件。 */
  static open(path: string): Ledger {
    const storage = Storage.open(path);
    return new Ledger(storage, storage.isSealed());
  }

  close(): void {
    this.storage.close();
  }

  get sealed(): boolean {
    return this.isSealed;
  }

  /** 追加保管事件，返回全局序号。封存后调用抛错。 */
  appendEvent(input: EventInput): number {
    if (this.isSealed) throw new Error("ledger is sealed");
    validateInput(input);
    return this.storage.appendEvent(input);
  }

  /** 批量追加事件（单事务），返回分配的全局序号数组。封存后调用抛错。 */
  appendEvents(inputs: EventInput[]): number[] {
    if (this.isSealed) throw new Error("ledger is sealed");
    for (const input of inputs) validateInput(input);
    const first = this.storage.appendEvents(inputs);
    return inputs.map((_, i) => first + i);
  }

  /** 封存账册并输出凭证（≤128 字节）。重复封存抛错。 */
  seal(): Credential {
    if (this.isSealed) throw new Error("ledger already sealed");
    const byKey = new Map<string, DirectoryLeaf>();
    let totalCount = 0;
    for (const event of this.storage.iterateEvents()) {
      totalCount += 1;
      const key = recordKey(event.recordId);
      const mapKey = key.toString("hex");
      let entry = byKey.get(mapKey);
      if (entry === undefined) {
        entry = { key, count: 0, head: ZERO_HEAD };
        byKey.set(mapKey, entry);
      }
      entry.head = chainStep(entry.head, hashEvent(key, event));
      entry.count += 1;
    }
    const leaves = [...byKey.values()].sort((a, b) => Buffer.compare(a.key, b.key));
    const root = computeRoot(leaves);
    this.storage.finalizeSeal(leaves, root, totalCount);
    this.isSealed = true;

    const total = Buffer.alloc(8);
    total.writeBigUInt64BE(BigInt(totalCount));
    this.credential = Buffer.concat([CREDENTIAL_MAGIC, total, root]);
    return this.credential;
  }

  /** 生成某记录的保管报告（封存后才可调用）。 */
  generateReport(recordId: string): CustodyReport {
    if (!this.isSealed) throw new Error("ledger is not sealed");
    const events = this.storage.eventsOfRecord(recordId);
    const reportEvents: ReportEvent[] = events
      .map((e) => ({ seq: e.seq, timestamp: e.timestamp, operator: e.operator, body: e.body }))
      .sort((a, b) => a.timestamp - b.timestamp || a.seq - b.seq);

    const leaves = this.storage.loadDirectory();
    const key = recordKey(recordId);
    const located = locateKey(leaves, key);

    let proof: ReportProof;
    if (located.found) {
      proof = {
        inclusion: {
          leaf: leafToData(leaves[located.index]!),
          proof: proveInclusion(leaves, located.index),
        },
        nonMembership: null,
      };
    } else {
      const left =
        located.index > 0
          ? {
              leaf: leafToData(leaves[located.index - 1]!),
              proof: proveInclusion(leaves, located.index - 1),
            }
          : null;
      const right =
        located.index < leaves.length
          ? {
              leaf: leafToData(leaves[located.index]!),
              proof: proveInclusion(leaves, located.index),
            }
          : null;
      proof = {
        inclusion: null,
        nonMembership: { leafCount: leaves.length, left, right },
      };
    }

    return { version: 1, recordId, events: reportEvents, proof };
  }
}

function validateInput(input: EventInput): void {
  if (typeof input.recordId !== "string" || input.recordId.length === 0) {
    throw new Error("recordId must be a non-empty string");
  }
  if (!Number.isSafeInteger(input.timestamp) || input.timestamp < 0) {
    throw new Error("timestamp must be a non-negative integer (UTC seconds)");
  }
  if (typeof input.operator !== "string") throw new Error("operator must be a string");
  if (typeof input.body !== "string") throw new Error("body must be a string");
}

export const CREDENTIAL_SIZE = CREDENTIAL_LENGTH;
