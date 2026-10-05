import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PipelineExecutor } from "../src/index";
import { RunRecord, RunStatus } from "../src/index";

export const NODE = process.execPath;

export function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `pipeline-test-${prefix}-`));
}

export function makeExecutor(dir: string, concurrency = 1): PipelineExecutor {
  return new PipelineExecutor({ dbPath: path.join(dir, "runs.sqlite"), concurrency });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 10000,
  intervalMs = 15
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await sleep(intervalMs);
  }
}

export async function waitStatus(
  executor: PipelineExecutor,
  runId: string,
  status: RunStatus,
  timeoutMs = 10000
): Promise<RunRecord> {
  await waitFor(() => executor.getRun(runId)?.status === status, timeoutMs);
  return executor.getRun(runId)!;
}

/** Write a fixture script into dir and return its absolute path. */
export function writeScript(dir: string, name: string, source: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, source);
  return file;
}

export function fileSize(file: string): number {
  return fs.statSync(file).size;
}
