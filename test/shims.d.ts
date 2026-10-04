/** 最小化的 Node 内置模块类型声明，避免依赖 @types/node。 */
declare module 'node:test' {
  export function test(name: string, fn: () => void): void;
}

declare module 'node:assert/strict' {
  interface Assert {
    (value: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
  }
  const assert: Assert;
  export default assert;
}
