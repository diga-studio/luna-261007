import * as fs from "node:fs";
import * as path from "node:path";
import type { Certificate } from "./types.js";

export class CertificateStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  private filePath(certificateId: string): string {
    return path.join(this.dir, `${certificateId}.json`);
  }

  write(cert: Certificate): void {
    const finalPath = this.filePath(cert.certificateId);
    const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
    const fd = fs.openSync(tmpPath, "w");
    try {
      fs.writeFileSync(fd, JSON.stringify(cert, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, finalPath);
  }

  read(certificateId: string): Certificate | null {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath(certificateId), "utf8");
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as Certificate;
      if (parsed.certificateId !== certificateId) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  listIds(): string[] {
    return fs
      .readdirSync(this.dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .sort();
  }

  remove(certificateId: string): void {
    try {
      fs.unlinkSync(this.filePath(certificateId));
    } catch {
      // already gone
    }
  }
}
