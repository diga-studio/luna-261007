import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConsentService } from "../src/index.js";

export interface TestContext {
  service: ConsentService;
  dbPath: string;
  dir: string;
  cleanup: () => void;
}

export function openService(): TestContext {
  const dir = mkdtempSync(join(tmpdir(), "consent-test-"));
  const dbPath = join(dir, "consent.db");
  const service = new ConsentService({ path: dbPath });
  return {
    service,
    dbPath,
    dir,
    cleanup: () => {
      try {
        service.close();
      } catch {
        /* already closed */
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

let counter = 0;
export function reqId(): string {
  counter += 1;
  return `req-${counter}`;
}
