// Minimal ambient declarations for the Node.js built-in modules used by this
// project. Keeps the build self-contained: the only devDependency needed on a
// clean machine is typescript itself.

declare module 'node:fs' {
  export function renameSync(oldPath: string, newPath: string): void;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function readFileSync(path: string): Uint8Array;
  export function writeFileSync(path: string, data: string | Uint8Array): void;
  export function existsSync(path: string): boolean;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function mkdtempSync(prefix: string): string;
  export function readdirSync(path: string): string[];
}

declare module 'node:crypto' {
  export interface Hash {
    update(data: string | Uint8Array): Hash;
    digest(encoding: 'hex'): string;
  }
  export function createHash(algorithm: string): Hash;
  export function randomBytes(size: number): Uint8Array;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function normalize(path: string): string;
  export function dirname(path: string): string;
  export function isAbsolute(path: string): boolean;
  export const sep: string;
}

declare module 'node:os' {
  export function tmpdir(): string;
}

declare module 'node:sqlite' {
  export interface StatementSync {
    run(...params: (string | number | null)[]): { changes: number };
    get(...params: (string | number | null)[]): unknown;
    all(...params: (string | number | null)[]): unknown[];
  }
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}

declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module 'node:assert/strict' {
  export function ok(value: unknown, message?: string): void;
  export function strictEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
  export function throws(fn: () => void, message?: string): void;
}
