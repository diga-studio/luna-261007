import * as fs from 'node:fs';
import * as path from 'node:path';
import type { StepLogRef } from './types';

function sanitize(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]+/g, '_');
  return cleaned.length > 0 ? cleaned : 'unnamed';
}

const FILE_RE = /^(\d{3})-(.+)\.(\d{3})-(.+)\.(stdout|stderr)\.log$/;

/** 日志写入：stdout/stderr 分文件、按到达顺序同步追加原始字节。 */
export class LogStore {
  constructor(private readonly logDir: string) {}

  createStepLogger(runId: string, stageIndex: number, stepIndex: number, stage: string, step: string): StepLogger {
    const dir = path.join(this.logDir, runId);
    fs.mkdirSync(dir, { recursive: true });
    const base = `${String(stageIndex).padStart(3, '0')}-${sanitize(stage)}.${String(stepIndex).padStart(3, '0')}-${sanitize(step)}`;
    const ref: StepLogRef = {
      stage,
      step,
      stdoutPath: path.join(dir, `${base}.stdout.log`),
      stderrPath: path.join(dir, `${base}.stderr.log`),
    };
    return new FileStepLogger(ref);
  }

  listStepLogs(runId: string): StepLogRef[] {
    const dir = path.join(this.logDir, runId);
    if (!fs.existsSync(dir)) return [];
    const byBase = new Map<string, StepLogRef>();
    for (const file of fs.readdirSync(dir).sort()) {
      const m = FILE_RE.exec(file);
      if (!m) continue;
      const key = `${m[1]}.${m[3]}`;
      let ref = byBase.get(key);
      if (!ref) {
        ref = { stage: m[2], step: m[4], stdoutPath: '', stderrPath: '' };
        byBase.set(key, ref);
      }
      if (m[5] === 'stdout') ref.stdoutPath = path.join(dir, file);
      else ref.stderrPath = path.join(dir, file);
    }
    return [...byBase.values()];
  }
}

class FileStepLogger implements StepLogger {
  private stdoutFd: number;
  private stderrFd: number;
  private closed = false;

  constructor(readonly ref: StepLogRef) {
    this.stdoutFd = fs.openSync(ref.stdoutPath, 'w');
    this.stderrFd = fs.openSync(ref.stderrPath, 'w');
  }

  writeStdout(chunk: Buffer): void {
    if (this.closed) return;
    fs.writeSync(this.stdoutFd, chunk);
  }

  writeStderr(chunk: Buffer): void {
    if (this.closed) return;
    fs.writeSync(this.stderrFd, chunk);
  }

  /** 刷盘并关闭；幂等。关闭后写入被丢弃。 */
  async finalize(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    fs.fsyncSync(this.stdoutFd);
    fs.fsyncSync(this.stderrFd);
    fs.closeSync(this.stdoutFd);
    fs.closeSync(this.stderrFd);
  }
}

export interface StepLogger {
  readonly ref: StepLogRef;
  writeStdout(chunk: Buffer): void;
  writeStderr(chunk: Buffer): void;
  finalize(): Promise<void>;
}
