/**
 * 极简测试框架与断言：不依赖 node:test / @types/node，
 * 保证在只装 Node.js 的干净机器上 npm install && npm test 可跑通。
 */

type TestFn = () => void | Promise<void>;

interface Case {
  name: string;
  fn: TestFn;
}

const cases: Case[] = [];

export function test(name: string, fn: TestFn): void {
  cases.push({ name, fn });
}

function repr(v: unknown): string {
  return JSON.stringify(v) ?? String(v);
}

function deepEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((v, i) => deepEq(v, b[i]));
  }
  if (typeof a === "object") {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every((k) =>
      deepEq(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
      ),
    );
  }
  return false;
}

export const assert = {
  deepEqual(actual: unknown, expected: unknown): void {
    if (!deepEq(actual, expected)) {
      throw new Error(
        `deepEqual failed\n  actual:   ${repr(actual)}\n  expected: ${repr(expected)}`,
      );
    }
  },
  equal(actual: unknown, expected: unknown): void {
    if (actual !== expected) {
      throw new Error(
        `equal failed\n  actual:   ${repr(actual)}\n  expected: ${repr(expected)}`,
      );
    }
  },
  ok(value: unknown, message?: string): void {
    if (!value) throw new Error(message ?? `expected truthy, got ${repr(value)}`);
  },
};

export async function runAll(): Promise<void> {
  let failed = 0;
  for (const c of cases) {
    try {
      await c.fn();
      process.stdout.write(`ok - ${c.name}\n`);
    } catch (err) {
      failed++;
      process.stdout.write(`FAIL - ${c.name}\n`);
      process.stderr.write(
        err instanceof Error ? `${err.stack ?? err.message}\n` : `${String(err)}\n`,
      );
    }
  }
  process.stdout.write(
    `\n${cases.length - failed}/${cases.length} tests passed\n`,
  );
  if (failed > 0) process.exit(1);
}
