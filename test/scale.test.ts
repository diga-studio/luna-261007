import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileP = promisify(execFile);
const childPath = fileURLToPath(new URL("../scripts/scale-child.mjs", import.meta.url));

interface ScaleResult {
  records: number;
  distinctV6: number;
  outputCount: number;
  mismatches: number;
  orderViolations: number;
  buildMs: number;
  compileMs: number;
  peakRssBytes: number;
  peakRssMiB: number;
}

const RSS_LIMIT = 512 * 1024 * 1024;

describe("scale: 500k shuffled records", () => {
  it(
    "builds, compiles and streams within the 512 MiB RSS budget",
    async () => {
      const { stdout } = await execFileP(process.execPath, [childPath], {
        maxBuffer: 16 * 1024 * 1024,
      });
      const result: ScaleResult = JSON.parse(stdout.trim().split("\n").pop()!);
      console.log(
        `scale: ${result.records} records (${result.distinctV6} distinct v6), ` +
          `${result.outputCount} outputs, build=${result.buildMs}ms, ` +
          `compile=${result.compileMs}ms, peakRSS=${result.peakRssMiB}MiB`,
      );
      expect(result.records).toBe(500_000);
      expect(result.distinctV6).toBeGreaterThanOrEqual(250_000);
      expect(result.outputCount).toBeGreaterThan(0);
      expect(result.mismatches).toBe(0);
      expect(result.orderViolations).toBe(0);
      expect(result.peakRssBytes).toBeLessThan(RSS_LIMIT);
    },
    300_000,
  );
});
