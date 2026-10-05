import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 持久化层缓存记录：写入路径 -> blob 哈希，及删除路径。 */
export interface LayerRecord {
  readonly writes: Record<string, string>;
  readonly deletes: readonly string[];
}

/** 基于本地文件系统的内容寻址缓存，跨实例保留。 */
export class Store {
  private tempCounter = 0;

  constructor(readonly cacheDir: string) {}

  async init(): Promise<void> {
    await mkdir(this.dir('blobs'), { recursive: true });
    await mkdir(this.dir('layers'), { recursive: true });
    await mkdir(this.dir('images'), { recursive: true });
  }

  /** 写入字节，返回内容哈希；已存在则直接返回。 */
  async putBlob(bytes: Uint8Array): Promise<string> {
    const hash = createHash('sha256').update(bytes).digest('hex');
    const path = join(this.dir('blobs'), hash);
    if ((await this.read(path)) === undefined) {
      await this.writeAtomic(path, bytes);
    }
    return hash;
  }

  async getBlob(hash: string): Promise<Uint8Array | undefined> {
    return this.read(join(this.dir('blobs'), hash));
  }

  /** 读取 RUN 层缓存。key 由命令与输入树哈希派生。 */
  async getLayer(key: string): Promise<LayerRecord | undefined> {
    const bytes = await this.read(join(this.dir('layers'), `${key}.json`));
    if (bytes === undefined) return undefined;
    return JSON.parse(new TextDecoder().decode(bytes)) as LayerRecord;
  }

  async putLayer(key: string, record: LayerRecord): Promise<void> {
    await this.writeAtomic(
      join(this.dir('layers'), `${key}.json`),
      new TextEncoder().encode(JSON.stringify(record)),
    );
  }

  /** 保存最终树清单（路径 -> blob 哈希），返回 imageId。 */
  async putImage(files: Record<string, string>): Promise<string> {
    const canonical = JSON.stringify(files, Object.keys(files).sort());
    const imageId = createHash('sha256').update(canonical).digest('hex');
    await this.writeAtomic(
      join(this.dir('images'), `${imageId}.json`),
      new TextEncoder().encode(canonical),
    );
    return imageId;
  }

  async getImage(imageId: string): Promise<Record<string, string> | undefined> {
    const bytes = await this.read(join(this.dir('images'), `${imageId}.json`));
    if (bytes === undefined) return undefined;
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, string>;
  }

  private dir(name: string): string {
    return join(this.cacheDir, name);
  }

  private async read(path: string): Promise<Uint8Array | undefined> {
    try {
      const data = await readFile(path);
      // readFile 返回 Buffer；统一转成普通 Uint8Array 再交给调用方。
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } catch {
      return undefined;
    }
  }

  /** 先写临时文件再改名，避免留下半截文件。 */
  private async writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
    const temp = `${path}.tmp-${process.pid}-${this.tempCounter++}`;
    await writeFile(temp, bytes);
    await rename(temp, path);
  }
}
