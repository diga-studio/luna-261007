import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PipelineRunner } from '../src/index';
import type { RunRecord, RunStatus } from '../src/index';

export interface TestContext {
  dir: string;
  runner: PipelineRunner;
}

export async function makeRunner(maxConcurrent = 1): Promise<TestContext> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-test-'));
  const runner = new PipelineRunner({
    dbPath: path.join(dir, 'runs.db'),
    logDir: path.join(dir, 'logs'),
    maxConcurrent,
  });
  await runner.init();
  return { dir, runner };
}

export function cleanup(ctx: TestContext): void {
  fs.rmSync(ctx.dir, { recursive: true, force: true });
}

const TERMINAL: RunStatus[] = ['Passed', 'Failed', 'Canceled'];

export async function waitForTerminal(runner: PipelineRunner, runId: string, timeoutMs = 15000): Promise<RunRecord> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const record = runner.getRun(runId);
    if (record && TERMINAL.includes(record.status)) return record;
    if (Date.now() > deadline) throw new Error(`run ${runId} did not reach terminal state in ${timeoutMs}ms (status=${record?.status})`);
    await sleep(20);
  }
}

export async function waitForFile(file: string, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fs.existsSync(file)) return;
    if (Date.now() > deadline) throw new Error(`file not created in ${timeoutMs}ms: ${file}`);
    await sleep(20);
  }
}

export async function waitForStatus(runner: PipelineRunner, runId: string, status: RunStatus, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (runner.getRun(runId)?.status === status) return;
    if (Date.now() > deadline) throw new Error(`run ${runId} did not reach status ${status}`);
    await sleep(20);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function fileSize(file: string): number {
  return fs.statSync(file).size;
}
