// Minimal ambient declarations for the Node.js built-ins used by this
// project. The project intentionally avoids a @types/node dependency so
// that `npm install` only needs to fetch typescript.
declare module "node:fs" {
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function writeFileSync(path: string, data: Uint8Array): void;
  export function readFileSync(path: string): Uint8Array;
  export function renameSync(oldPath: string, newPath: string): void;
  export function existsSync(path: string): boolean;
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function readdirSync(path: string): string[];
}

declare module "node:path" {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
  export class StatementSync {
    run(...params: Array<string | number | null>): { changes: number };
    get(...params: Array<string | number | null>): Record<string, unknown> | undefined;
    all(...params: Array<string | number | null>): Array<Record<string, unknown>>;
  }
}

declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
}

declare module "node:assert" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function throws(fn: () => void, expected?: RegExp | ((err: unknown) => boolean) | (new (...args: any[]) => Error), message?: string): void;
}

declare class Buffer extends Uint8Array {
  static from(data: string, encoding: string): Buffer;
}
