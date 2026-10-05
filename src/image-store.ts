import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Content-addressed local PNG file storage. */
export class ImageStore {
  private dir: string;

  constructor(imagesDir: string) {
    this.dir = imagesDir;
    mkdirSync(this.dir, { recursive: true });
  }

  /** Persist a PNG, returning its content-addressed image id. */
  save(png: Buffer): string {
    const hash = createHash('sha256');
    hash.update(png);
    const id = hash.digest('hex');
    const path = this.pathFor(id);
    if (!existsSync(path)) {
      writeFileSync(path, png);
    }
    return id;
  }
  read(imageId: string): Buffer {
    return readFileSync(this.pathFor(imageId));
  }
  pathFor(imageId: string): string {
    return join(this.dir, `${imageId}.png`);
  }
  remove(imageId: string): void {
    const path = this.pathFor(imageId);
    if (existsSync(path)) {
      unlinkSync(path);
    }
  }
}
