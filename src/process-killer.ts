import { spawn } from 'node:child_process';

export interface SpawnedStep {
  pid: number;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  /** 主程序退出（或启动失败）时 resolve。 */
  exited: Promise<{ code: number | null; error: Error | null }>;
  /** stdio 全部关闭时 resolve（含仍持有管道后代被清理之后）。 */
  closed: Promise<void>;
}

/**
 * 以独立进程组启动步骤主程序（POSIX: setsid；Windows: 由 taskkill /T 兜底）。
 * 输入程序不会主动脱离进程树，因此进程组覆盖全部后代。
 */
export function spawnStep(
  command: string,
  args: string[],
  cwd: string | undefined,
  env: Record<string, string> | undefined,
): SpawnedStep {
  const child = spawn(command, args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const exited = new Promise<{ code: number | null; error: Error | null }>((resolve) => {
    let settled = false;
    child.once('error', (error) => {
      if (!settled) {
        settled = true;
        resolve({ code: null, error });
      }
    });
    child.once('exit', (code) => {
      if (!settled) {
        settled = true;
        resolve({ code, error: null });
      }
    });
  });

  const closed = new Promise<void>((resolve) => {
    child.once('close', () => resolve());
    // spawn 失败时不会触发 close，兜底 resolve。
    child.once('error', () => resolve());
  });

  return {
    pid: child.pid ?? -1,
    stdout: child.stdout!,
    stderr: child.stderr!,
    exited,
    closed,
  };
}

function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    // EPERM 说明组仍存在但无权发信号；ESRCH 说明组已空。
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitGroupEmpty(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!groupExists(pid)) return true;
    await sleep(10);
  }
  return !groupExists(pid);
}

/** 终止进程组内全部进程（含后代）；resolve 时进程组已空，不会再有写文件等副作用。 */
export async function killProcessTree(pid: number): Promise<void> {
  if (pid <= 0) return;
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
      killer.once('exit', () => resolve());
      killer.once('error', () => resolve());
    });
    return;
  }
  // 先 SIGTERM 给进程组一次退出机会，再 SIGKILL 强杀。
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    try {
      process.kill(-pid, signal);
    } catch {
      // 组已空，忽略。
    }
    const grace = signal === 'SIGTERM' ? 1000 : 5000;
    if (await waitGroupEmpty(pid, grace)) return;
  }
  // SIGKILL 后内核收割极快，最后再等一次确保组空。
  await waitGroupEmpty(pid, 5000);
}
