import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface LayerRecord {
  /** 路径 -> blob 哈希 */
  readonly writes: Readonly<Record<string, string>>;
  readonly deletes: readonly string[];
}

export interface ImageManifest {
  readonly files: Record<string, string>;
}

/** 基于本地文件系统的持久缓存：blob / 层记录 / 镜像清单，跨实例保留 */
export class CacheStore {
  constructor(readonly dir: string) {}

  private blobPath(hash: string): string {
    return join(this.dir, "blobs", hash);
  }

  private layerPath(key: string): string {
    return join(this.dir, "layers", `${key}.json`);
  }

  private imagePath(imageId: string): string {
    return join(this.dir, "images", `${imageId}.json`);
  }

  private async ensureSubdirs(): Promise<void> {
    await Promise.all([
      mkdir(join(this.dir, "blobs"), { recursive: true }),
      mkdir(join(this.dir, "layers"), { recursive: true }),
      mkdir(join(this.dir, "images"), { recursive: true }),
    ]);
  }

  async hasBlob(hash: string): Promise<boolean> {
    try {
      await open(this.blobPath(hash), "r").then((f) => f.close());
      return true;
    } catch {
      return false;
    }
  }

  async writeBlob(hash: string, data: Uint8Array): Promise<void> {
    await this.ensureSubdirs();
    const dest = this.blobPath(hash);
    const tmp = `${dest}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    await writeFile(tmp, data);
    await rename(tmp, dest);
  }

  async readBlob(hash: string): Promise<Uint8Array> {
    const buf = await readFile(this.blobPath(hash));
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  async getLayer(key: string): Promise<LayerRecord | undefined> {
    try {
      const raw = await readFile(this.layerPath(key), "utf8");
      return JSON.parse(raw) as LayerRecord;
    } catch {
      return undefined;
    }
  }

  async putLayer(key: string, record: LayerRecord): Promise<void> {
    await this.ensureSubdirs();
    const dest = this.layerPath(key);
    const tmp = `${dest}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    await writeFile(tmp, JSON.stringify(record));
    await rename(tmp, dest);
  }

  async putImage(imageId: string, files: Record<string, string>): Promise<void> {
    await this.ensureSubdirs();
    const dest = this.imagePath(imageId);
    const tmp = `${dest}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    await writeFile(tmp, JSON.stringify({ files } satisfies ImageManifest));
    await rename(tmp, dest);
  }

  async getImage(imageId: string): Promise<Record<string, string> | undefined> {
    try {
      const raw = await readFile(this.imagePath(imageId), "utf8");
      return (JSON.parse(raw) as ImageManifest).files;
    } catch {
      return undefined;
    }
  }
}
