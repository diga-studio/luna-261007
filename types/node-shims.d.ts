// Minimal type declarations for the Node.js built-in modules used by this
// project. Keeps the build self-contained (no @types/node dependency).
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

declare module 'node:test' {
  export interface TestContext {
    test(name: string, fn: () => void | Promise<void>): Promise<void>;
  }
  export function test(name: string, fn: () => void | Promise<void>): Promise<void>;
  export function test(
    name: string,
    options: { timeout?: number },
    fn: () => void | Promise<void>,
  ): Promise<void>;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void | Promise<void>): void;
  export default test;
}

declare module 'node:assert/strict' {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function throws(fn: () => void, message?: string): void;
}

declare module 'node:fs' {
  export function rmSync(path: string, options?: { force?: boolean; recursive?: boolean }): void;
  export function mkdtempSync(prefix: string): string;
}

declare module 'node:os' {
  export function tmpdir(): string;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
}

declare const process: {
  env: Record<string, string | undefined>;
};

declare const performance: { now(): number };
declare const console: { log(...args: unknown[]): void };
