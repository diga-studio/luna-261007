// 最小化的 Node 内置测试模块类型声明，避免引入 @types/node 依赖。
declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  interface Assert {
    deepEqual(actual: unknown, expected: unknown): void;
    throws(fn: () => unknown): void;
  }
  const assert: Assert;
  export default assert;
}
