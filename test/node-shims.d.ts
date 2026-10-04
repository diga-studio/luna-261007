// Minimal ambient declarations so the repo typechecks without @types/node.
// (npm install only fetches typescript; tests run on Node's built-in modules.)
declare module "node:test" {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module "node:assert/strict" {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): asserts value;
    throws(fn: () => void): void;
  }
  const assert: Assert;
  export default assert;
}

declare var process: {
  memoryUsage(): { rss: number };
  exit(code: number): never;
};
