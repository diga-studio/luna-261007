import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PurgeWave, RETENTION_MS, type PurgeWaveOptions } from "../src/index.js";

export { RETENTION_MS };

export const T0 = 1_700_000_000_000;

export class SimulatedCrash extends Error {
  constructor(point: string) {
    super(`simulated crash at ${point}`);
    this.name = "SimulatedCrash";
  }
}

export class CrashPlan {
  private counts = new Map<string, number>();
  constructor(private triggers: { point: string; after: number }[]) {}

  hook = (point: string): void => {
    const seen = (this.counts.get(point) ?? 0) + 1;
    this.counts.set(point, seen);
    for (const trigger of this.triggers) {
      if (trigger.point === point && seen === trigger.after) {
        throw new SimulatedCrash(point);
      }
    }
  };
}

export interface Fixture {
  root: string;
  storageDir: string;
  dataDir: string;
  clock: { now: () => number; set: (t: number) => void; advance: (ms: number) => void };
  instances: PurgeWave[];
  open: (crashPlan?: CrashPlan) => PurgeWave;
  reopen: (instance: PurgeWave, crashPlan?: CrashPlan) => PurgeWave;
  makeFile: (name: string, size?: number) => { path: string; content: Buffer };
  writeFile: (path: string, content: Buffer | string) => void;
  readFile: (path: string) => Buffer;
  exists: (path: string) => boolean;
  retainedNames: () => string[];
  closeAll: () => void;
}

export function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "purgewave-test-"));
  const storageDir = join(root, "purgewave-store");
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });

  let current = T0;
  const clock = {
    now: () => current,
    set: (t: number) => {
      current = t;
    },
    advance: (ms: number) => {
      current += ms;
    },
  };

  const instances: PurgeWave[] = [];

  const open = (crashPlan?: CrashPlan): PurgeWave => {
    const options: PurgeWaveOptions = {
      dir: storageDir,
      now: clock.now,
      crashHook: crashPlan ? crashPlan.hook : undefined,
    };
    const instance = new PurgeWave(options);
    instances.push(instance);
    return instance;
  };

  const reopen = (instance: PurgeWave, crashPlan?: CrashPlan): PurgeWave => {
    try {
      instance.close();
    } catch {
      // a "crashed" instance may already be closed
    }
    return open(crashPlan);
  };

  const makeFile = (name: string, size = 64): { path: string; content: Buffer } => {
    const path = join(dataDir, name);
    mkdirSync(join(path, ".."), { recursive: true });
    const content = randomBytes(size);
    writeFileSync(path, content);
    return { path, content };
  };

  return {
    root,
    storageDir,
    dataDir,
    clock,
    instances,
    open,
    reopen,
    makeFile,
    writeFile: (path, content) => writeFileSync(path, content),
    readFile: (path) => readFileSync(path),
    exists: (path) => existsSync(path),
    retainedNames: () => {
      const dir = join(storageDir, "retained");
      return existsSync(dir) ? readdirSync(dir) : [];
    },
    closeAll: () => {
      for (const instance of instances) {
        try {
          instance.close();
        } catch {
          // ignore
        }
      }
    },
  };
}
