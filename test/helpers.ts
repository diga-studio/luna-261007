import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PurgeWave } from "../src/index.js";
import type { FaultEvent } from "../src/index.js";

export class FakeClock {
  private t: number;
  constructor(start = 1_700_000_000_000) {
    this.t = start;
  }
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
  set(t: number): void {
    this.t = t;
  }
}

/** Simulates a process crash by throwing after `failAfter` fault events. */
export class CrashSim {
  private count = 0;
  constructor(private failAfter: number) {}
  hook = (_event: FaultEvent): void => {
    if (this.count++ >= this.failAfter) {
      throw new Error("simulated crash");
    }
  };
}

export interface TestEnv {
  root: string;
  workDir: string;
  storageDir: string;
  clock: FakeClock;
  open(faultHook?: (e: FaultEvent) => void): PurgeWave;
  cleanup(): void;
}

export function makeEnv(): TestEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "purgewave-test-"));
  const workDir = path.join(root, "work");
  const storageDir = path.join(root, "storage");
  fs.mkdirSync(workDir, { recursive: true });
  const clock = new FakeClock();
  return {
    root,
    workDir,
    storageDir,
    clock,
    open(faultHook) {
      return new PurgeWave({ storageDir, now: () => clock.now(), faultHook });
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export function writeFiles(dir: string, files: Record<string, Buffer | string>): string[] {
  const paths: string[] = [];
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    paths.push(p);
  }
  return paths;
}

export function readFile(p: string): Buffer {
  return fs.readFileSync(p);
}

export function exists(p: string): boolean {
  return fs.existsSync(p);
}

/** Lists every retained blob file currently on disk (relative to blobs/). */
export function listBlobs(storageDir: string): string[] {
  const blobsDir = path.join(storageDir, "blobs");
  if (!fs.existsSync(blobsDir)) return [];
  const out: string[] = [];
  for (const dir of fs.readdirSync(blobsDir)) {
    const full = path.join(blobsDir, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const f of fs.readdirSync(full)) out.push(path.join(dir, f));
  }
  return out.sort();
}

export function randomBytes(n: number): Buffer {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + 7) % 256;
  return b;
}
