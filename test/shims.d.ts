/** node:test 与 node:assert/strict 的最小类型声明，避免依赖 @types/node。 */
declare module "node:test" {
  export type TestFn = () => void | Promise<void>;
  export default function test(name: string, fn: TestFn): void;
}

declare module "node:assert/strict" {
  export function equal(actual: unknown, expected: unknown): void;
  export function deepEqual(actual: unknown, expected: unknown): void;
  export function ok(value: unknown, message?: string): asserts value;
  export function match(actual: string, pattern: RegExp): void;
  const assert: {
    equal: typeof equal;
    deepEqual: typeof deepEqual;
    ok: typeof ok;
    match: typeof match;
  };
  export default assert;
}
