// 极简 Node.js API 声明：仅覆盖本库用到的接口，避免依赖 @types/node。

declare class Buffer extends Uint8Array {
  static from(data: string, encoding?: string): Buffer;
  static from(data: Uint8Array): Buffer;
  static from(data: number[]): Buffer;
  static concat(list: Uint8Array[]): Buffer;
  static alloc(size: number, fill?: number): Buffer;
  static compare(a: Uint8Array, b: Uint8Array): number;
  static byteLength(data: string, encoding?: string): number;
  toString(encoding?: string): string;
  equals(other: Uint8Array): boolean;
  writeBigUInt64BE(value: bigint, offset?: number): number;
  readBigUInt64BE(offset?: number): bigint;
  writeUInt32BE(value: number, offset?: number): number;
  subarray(start?: number, end?: number): Buffer;
}

declare const __dirname: string;

declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
};

declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
  exitCode: number | undefined;
  memoryUsage(): { rss: number; heapUsed: number; heapTotal: number };
  resourceUsage(): { maxRSS: number };
  hrtime: { bigint(): bigint };
  platform: string;
};

declare module "node:crypto" {
  export interface Hash {
    update(data: Uint8Array | string): Hash;
    digest(): Buffer;
  }
  export function createHash(algorithm: string): Hash;
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
}

declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
  export interface StatementSync {
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    iterate(...params: unknown[]): IterableIterator<unknown>;
  }
}

declare module "node:test" {
  type TestFn = () => void | Promise<void>;
  export function test(name: string, fn: TestFn): void;
  export function test(name: string, options: { timeout?: number }, fn: TestFn): void;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: TestFn): void;
  export function before(fn: TestFn): void;
  export function after(fn: TestFn): void;
  export default test;
}

declare module "node:assert" {
  export function ok(value: unknown, message?: string): asserts value;
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function strictEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
  export function throws(fn: () => void, matcher?: RegExp | ((err: unknown) => boolean)): void;
  const assert: {
    ok: typeof ok;
    equal: typeof equal;
    strictEqual: typeof strictEqual;
    deepStrictEqual: typeof deepStrictEqual;
    throws: typeof throws;
  };
  export default assert;
}

declare module "node:fs" {
  export function mkdtempSync(prefix: string): string;
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function readFileSync(path: string): Buffer;
  export function writeFileSync(path: string, data: Uint8Array | string): void;
  export function copyFileSync(src: string, dest: string): void;
  export function statSync(path: string): { size: number };
}

declare module "node:child_process" {
  export interface SpawnSyncResult {
    status: number | null;
    stdout: Buffer;
    stderr: Buffer;
    error?: Error;
  }
  export function spawnSync(
    command: string,
    args: string[],
    options?: { encoding?: string; maxBuffer?: number },
  ): SpawnSyncResult;
}

declare module "node:os" {
  export function tmpdir(): string;
  export function platform(): string;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
}
