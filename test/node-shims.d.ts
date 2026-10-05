// 本工程测试仅用到 node:test 与 node:assert/strict 的极小子集。
// 为了不依赖 @types/node（干净机器 npm install 即可跑通），在此提供最小声明。
declare module 'node:test' {
  export type TestFn = () => void | Promise<void>;
  export default function test(name: string, fn: TestFn): void;
}

declare module 'node:assert/strict' {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
    fail(message?: string): never;
  }
  const assert: Assert;
  export default assert;
}
