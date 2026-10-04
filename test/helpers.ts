import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Manifest } from "../src/index";

export function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `snapshot-repo-${prefix}-`));
}

export function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export interface Fixture {
  manifest: Manifest;
  pomContent: Buffer;
  jarContent: Buffer;
  pomPath: string;
  jarPath: string;
}

/** 生成一组清单与匹配的源文件。 */
export function makeFixture(
  dir: string,
  name: string,
  opts?: { timestampUtc?: string; pomSize?: number; jarSize?: number }
): Fixture {
  const pomContent = crypto.randomBytes(opts?.pomSize ?? 1024);
  const jarContent = crypto.randomBytes(opts?.jarSize ?? 4096);
  const pomPath = path.join(dir, `${name}.pom`);
  const jarPath = path.join(dir, `${name}.jar`);
  fs.writeFileSync(pomPath, pomContent);
  fs.writeFileSync(jarPath, jarContent);
  return {
    pomContent,
    jarContent,
    pomPath,
    jarPath,
    manifest: {
      groupId: "com.example",
      artifactId: "demo",
      version: "1.4-SNAPSHOT",
      timestampUtc: opts?.timestampUtc ?? "20261004.091500",
      files: {
        pom: { length: pomContent.length, sha256: sha256(pomContent) },
        jar: { length: jarContent.length, sha256: sha256(jarContent) },
      },
    },
  };
}
