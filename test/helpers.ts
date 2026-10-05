import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gps-tracker-"));
  return path.join(dir, "test.db");
}

export function assertClose(actual: number, expected: number, msg?: string): void {
  const tol = Math.max(1e-3, Math.abs(expected) * 1e-9);
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${msg ?? "distance"}: actual=${actual} expected=${expected}`,
  );
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(arr: T[], rand: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
