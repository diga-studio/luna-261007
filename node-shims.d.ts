/**
 * 零依赖工程的最小 Node 类型声明，仅覆盖本工程用到的 API，
 * 使 `npm run typecheck`（需自行安装 typescript）无需 @types/node 即可运行。
 */
declare module "node:test" {
  export default function test(
    name: string,
    fn: () => void | Promise<void>,
  ): void;
}

declare module "node:assert/strict" {
  const assert: {
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    throws(fn: () => void): void;
  };
  export default assert;
}

declare const console: {
  log(...args: unknown[]): void;
};
