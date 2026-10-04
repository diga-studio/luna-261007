// Minimal ambient declarations for the Node.js built-ins used by the tests.
// Keeps `npm install` limited to typescript only; no @types/node required.
declare module "node:test" {
  export interface TestContext {
    readonly name: string;
  }
  export type TestFn = (t: TestContext) => void | Promise<void>;
  export default function test(name: string, fn: TestFn): void;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: TestFn): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function throws(fn: () => unknown, message?: string): void;
}

declare const process: {
  hrtime: { bigint(): bigint };
};

declare const console: {
  log(...args: unknown[]): void;
};
