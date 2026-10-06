// 最小 Node 类型声明：避免依赖 @types/node，干净机器只需安装 typescript。
declare module "node:test" {
  export function test(name: string, fn: () => unknown): void;
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => unknown): void;
}
declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown, message?: string): void;
  export function notEqual(actual: unknown, expected: unknown, message?: string): void;
  export function deepEqual(actual: unknown, expected: unknown, message?: string): void;
  export function ok(value: unknown, message?: string): void;
  export function throws(fn: () => unknown, message?: string): void;
  const assert: {
    equal: typeof equal;
    notEqual: typeof notEqual;
    deepEqual: typeof deepEqual;
    ok: typeof ok;
    throws: typeof throws;
  };
  export default assert;
}
declare var process: {
  memoryUsage(): { heapUsed: number; heapTotal: number; rss: number };
};
declare var console: { log(...args: unknown[]): void };
