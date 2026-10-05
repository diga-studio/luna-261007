// Minimal ambient declarations for the Node.js built-ins used by this
// library. The project intentionally has no runtime dependencies and does
// not require @types/node, so only the small API surface we rely on is
// declared here.

declare module 'node:buffer' {
  export class Buffer extends Uint8Array {
    static from(data: Uint8Array | number[] | ArrayBuffer): Buffer;
    static from(data: string, encoding?: string): Buffer;
    static alloc(size: number, fill?: number): Buffer;
    static concat(list: Uint8Array[]): Buffer;
    static isBuffer(value: unknown): value is Buffer;
    readUInt32BE(offset: number): number;
    writeUInt32BE(value: number, offset: number): number;
    subarray(start?: number, end?: number): Buffer;
    equals(other: Uint8Array): boolean;
    toString(encoding?: string): string;
  }
}

declare module 'node:fs' {
  import { Buffer } from 'node:buffer';
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function readFileSync(path: string): Buffer;
  export function writeFileSync(path: string, data: Uint8Array | string): void;
  export function readdirSync(path: string): string[];
  export function unlinkSync(path: string): void;
  export function renameSync(oldPath: string, newPath: string): void;
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
}

declare module 'node:os' {
  export function tmpdir(): string;
}

declare module 'node:zlib' {
  import { Buffer } from 'node:buffer';
  export function deflateSync(data: Uint8Array): Buffer;
  export function inflateSync(data: Uint8Array): Buffer;
}

declare module 'node:crypto' {
  export function randomUUID(): string;
  export function createHash(algorithm: string): {
    update(data: Uint8Array): void;
    digest(encoding: 'hex'): string;
  };
}

declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
  export class StatementSync {
    run(...params: Array<string | number | null>): { changes: number; lastInsertRowid: number | bigint };
    get(...params: Array<string | number | null>): Record<string, unknown> | undefined;
    all(...params: Array<string | number | null>): Array<Record<string, unknown>>;
  }
}

declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module 'node:assert' {
  export function ok(value: unknown, message?: string): void;
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function fail(message?: string): never;
}

declare function setImmediate(callback: () => void): void;
