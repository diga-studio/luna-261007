import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";

export class RetentionStore {
  private dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(this.dir, { recursive: true });
  }

  newStoredName(): string {
    return randomUUID();
  }

  private fullPath(storedName: string): string {
    return join(this.dir, storedName);
  }

  has(storedName: string): boolean {
    return existsSync(this.fullPath(storedName));
  }

  moveIn(originalPath: string, storedName: string): void {
    renameSync(originalPath, this.fullPath(storedName));
  }

  moveOut(storedName: string, originalPath: string): void {
    mkdirSync(dirname(originalPath), { recursive: true });
    renameSync(this.fullPath(storedName), originalPath);
  }

  remove(storedName: string): void {
    rmSync(this.fullPath(storedName), { force: true });
  }

  listOrphans(knownNames: Set<string>): string[] {
    return readdirSync(this.dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !knownNames.has(entry.name))
      .map((entry) => entry.name);
  }
}
