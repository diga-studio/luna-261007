// 本库仅依赖 Node.js 内置模块；为避免强制安装 @types/node，
// 这里给出测试用到的最小类型声明。
declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  interface Assert {
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    throws(fn: () => unknown, message?: string): void;
  }
  const assert: Assert;
  export default assert;
}
