// 本项目只依赖 Node.js 内置模块；为避免强制依赖 @types/node，
// 这里给出所用 API 的最小声明。
declare module 'node:sqlite' {
  export interface StatementResultingChanges {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  }
  export class StatementSync {
    run(...params: unknown[]): StatementResultingChanges;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
declare module 'node:crypto' {
  export function randomUUID(): string;
}
declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
}
declare module 'node:assert/strict' {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function fail(message?: string): never;
}
declare module 'node:fs' {
  export function mkdtempSync(prefix: string): string;
  export function writeFileSync(path: string, data: string): void;
  export function readFileSync(path: string, encoding: string): string;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function existsSync(path: string): boolean;
}
declare module 'node:os' {
  export function tmpdir(): string;
}
declare module 'node:path' {
  export function join(...parts: string[]): string;
}
declare var process: {
  argv: string[];
  exitCode?: number;
  stdout: { write(data: string): void };
};
declare var __dirname: string;
declare module 'node:child_process' {
  export interface SpawnResult {
    status: number | null;
    stdout: string;
    stderr: string;
  }
  export function spawnSync(
    command: string,
    args: string[],
    options?: { encoding?: string; cwd?: string },
  ): SpawnResult;
  export interface ChildProcess {
    stdout: { on(event: 'data', cb: (chunk: string) => void): void } | null;
    stderr: { on(event: 'data', cb: (chunk: string) => void): void } | null;
    on(event: 'close', cb: (code: number | null) => void): void;
    on(event: 'error', cb: (err: Error) => void): void;
  }
  export function spawn(command: string, args: string[]): ChildProcess;
}
