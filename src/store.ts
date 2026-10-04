import * as fs from "node:fs";
import * as path from "node:path";
import type { TemplateRevision } from "./types";

function encodeId(templateId: string): string {
  return encodeURIComponent(templateId);
}

/** 基于本地文件的修订持久化存储（原子写入：临时文件 + rename） */
export class RevisionStore {
  private readonly dataDir: string;
  private readonly heads = new Map<string, number>();
  private readonly cache = new Map<string, TemplateRevision>();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
  }

  private templateDir(templateId: string): string {
    return path.join(this.dataDir, "templates", encodeId(templateId));
  }

  private revisionsDir(templateId: string): string {
    return path.join(this.templateDir(templateId), "revisions");
  }

  private revisionPath(templateId: string, revision: number): string {
    return path.join(this.revisionsDir(templateId), `${revision}.json`);
  }

  private metaPath(templateId: string): string {
    return path.join(this.templateDir(templateId), "meta.json");
  }

  private static atomicWrite(filePath: string, data: string): void {
    const tmp = `${filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, data, "utf8");
    fs.renameSync(tmp, filePath);
  }

  headRevision(templateId: string): number {
    const cached = this.heads.get(templateId);
    if (cached !== undefined) return cached;
    let head = 0;
    try {
      const meta = JSON.parse(fs.readFileSync(this.metaPath(templateId), "utf8")) as { head?: number };
      if (typeof meta.head === "number") head = meta.head;
    } catch {
      head = 0;
    }
    this.heads.set(templateId, head);
    return head;
  }

  /** 追加一个修订，返回递增修订号 */
  append(templateId: string, revision: TemplateRevision): number {
    const head = this.headRevision(templateId);
    const next = head + 1;
    fs.mkdirSync(this.revisionsDir(templateId), { recursive: true });
    const record: TemplateRevision = { ...revision, templateId, revision: next };
    RevisionStore.atomicWrite(this.revisionPath(templateId, next), JSON.stringify(record));
    RevisionStore.atomicWrite(this.metaPath(templateId), JSON.stringify({ head: next }));
    this.heads.set(templateId, next);
    this.cache.set(`${templateId}#${next}`, record);
    return next;
  }

  /** 读取指定修订（供已绑定批次使用，不受保留窗口限制） */
  get(templateId: string, revision: number): TemplateRevision | undefined {
    const key = `${templateId}#${revision}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    try {
      const record = JSON.parse(fs.readFileSync(this.revisionPath(templateId, revision), "utf8")) as TemplateRevision;
      this.cache.set(key, record);
      return record;
    } catch {
      return undefined;
    }
  }

  /** 读取最近 limit 个修订（含当前修订），按修订号升序 */
  latest(templateId: string, limit: number): TemplateRevision[] {
    const head = this.headRevision(templateId);
    const from = Math.max(1, head - limit + 1);
    const out: TemplateRevision[] = [];
    for (let n = from; n <= head; n++) {
      const record = this.get(templateId, n);
      if (record !== undefined) out.push(record);
    }
    return out;
  }

  /** 清理修订号小于 keepFrom 且未被批次钉住的旧修订文件 */
  prune(templateId: string, keepFrom: number, pinned: ReadonlySet<number>): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.revisionsDir(templateId));
    } catch {
      return;
    }
    for (const entry of entries) {
      const match = /^(\d+)\.json$/.exec(entry);
      if (match === null) continue;
      const n = Number(match[1]);
      if (n < keepFrom && !pinned.has(n)) {
        try {
          fs.unlinkSync(this.revisionPath(templateId, n));
          this.cache.delete(`${templateId}#${n}`);
        } catch {
          // 忽略清理失败，不影响主流程
        }
      }
    }
  }
}
