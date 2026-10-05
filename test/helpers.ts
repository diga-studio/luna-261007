import type { FileTree, RunFn, RunResult } from "../src/index.js";

export interface RunCall {
  command: string;
  tree: FileTree;
}

export interface MockRun {
  fn: RunFn;
  calls: RunCall[];
  count(command: string): number;
  total(): number;
}

type Handler = (tree: FileTree) => RunResult;

/** 以命令 -> 处理器 的表驱动 mock run，记录每次调用 */
export function makeRun(handlers: Record<string, Handler>): MockRun {
  const calls: RunCall[] = [];
  const fn: RunFn = async (command, tree) => {
    calls.push({ command, tree: new Map(tree) });
    const handler = handlers[command];
    if (handler === undefined) {
      throw new Error(`unexpected run command: ${command}`);
    }
    return handler(tree);
  };
  return {
    fn,
    calls,
    count: (command) => calls.filter((c) => c.command === command).length,
    total: () => calls.length,
  };
}

export function tree(entries: Record<string, Uint8Array>): FileTree {
  return new Map(Object.entries(entries));
}

export function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** 0..255 全字节值的二进制内容 */
export function allBytes(): Uint8Array {
  const out = new Uint8Array(256);
  for (let i = 0; i < 256; i++) out[i] = i;
  return out;
}
