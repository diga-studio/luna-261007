// 仅用于本机离线验证（全局 TS 4.6 无 @types/node）。交付构建不使用本文件。
declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}
declare module "node:assert/strict" {
  const assert: {
    equal(a: unknown, b: unknown): void;
    notEqual(a: unknown, b: unknown): void;
    deepEqual(a: unknown, b: unknown): void;
    ok(v: unknown): asserts v;
  };
  export default assert;
}
