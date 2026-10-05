import { spawn } from "node:child_process";
import { StepDefinition } from "./types";

export interface StepExit {
  /** Exit code of the main program, or null when killed by a signal. */
  code: number | null;
  /** Present when the program could not be started at all. */
  spawnError?: Error;
}

export interface SpawnedStep {
  /** Resolves once the main program has exited (or failed to start). */
  exit: Promise<StepExit>;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  /**
   * Stop the main program and all of its descendants.
   * Resolves when the whole process group is gone.
   * Idempotent: safe to call multiple times and after natural exit.
   */
  killTree(): Promise<void>;
}

const TERM_GRACE_MS = 1500;
const POLL_INTERVAL_MS = 25;
const KILL_TIMEOUT_MS = 5000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Spawn a step's main program in its own process group (detached), so the
 * whole tree can be signaled via the negative pgid. Step programs are
 * assumed not to detach themselves from the process tree they start in.
 */
export function spawnStep(step: StepDefinition): SpawnedStep {
  const child = spawn(step.command, step.args ?? [], {
    cwd: step.cwd,
    env: { ...process.env, ...(step.env ?? {}) },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let exited = false;
  const exit = new Promise<StepExit>((resolve) => {
    child.once("error", (err) => {
      exited = true;
      resolve({ code: null, spawnError: err });
    });
    child.once("exit", (code) => {
      exited = true;
      resolve({ code });
    });
  });

  const groupExists = (): boolean => {
    if (child.pid === undefined) return false;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  const signalGroup = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      // Group already gone.
    }
  };

  const waitGroupGone = async (timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (groupExists()) {
      if (Date.now() >= deadline) return false;
      await sleep(POLL_INTERVAL_MS);
    }
    return true;
  };

  let killPromise: Promise<void> | null = null;
  const killTree = (): Promise<void> => {
    if (killPromise) return killPromise;
    killPromise = (async () => {
      if (child.pid === undefined) {
        await exit;
        return;
      }
      // SIGTERM the whole group (main program + descendants still in it).
      signalGroup("SIGTERM");
      const gone = await waitGroupGone(TERM_GRACE_MS);
      if (!gone) {
        signalGroup("SIGKILL");
        await waitGroupGone(KILL_TIMEOUT_MS);
      }
      // Make sure the main program's exit has been observed too.
      if (!exited) await exit;
    })();
    return killPromise;
  };

  return { exit, stdout: child.stdout, stderr: child.stderr, killTree };
}
