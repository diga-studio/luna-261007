// Minimal Node.js globals/modules used by tests (avoids a hard dependency on @types/node).
declare const process: {
  platform: string;
  memoryUsage(): { rss: number; heapUsed: number; heapTotal: number };
  resourceUsage(): { maxRSS: number };
  hrtime: { bigint(): bigint };
};
declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
declare module "node:test" {
  export function test(name: string, fn: () => unknown | Promise<unknown>): void | Promise<unknown>;
}
declare module "node:assert/strict" {
  const assert: {
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
  };
  export default assert;
}
