import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { MAX_TOTAL_SIZE } from "../src/index.js";

const LIMIT = 32 * 1024 * 1024; // 32 MiB
const CHILD = path.resolve("build/test/helpers/memoryChild.js");

test("100 MiB 素材完整入库且新增峰值内存 < 32 MiB", { timeout: 300_000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ingest-100m-"));
  try {
    const r = spawnSync(process.execPath, ["--expose-gc", CHILD, dir], {
      stdio: "pipe",
      timeout: 240_000,
    });
    if (r.error) throw r.error;
    assert.equal(r.status, 0, `memory child failed:\n${r.stderr}`);
    const out = JSON.parse(String(r.stdout).trim().split("\n").pop() as string) as {
      usedDelta: number;
      peakDelta: number;
      productSha: string;
      expectedSha: string;
      productSize: number;
    };
    console.log(
      `    memory: used+${(out.usedDelta / 1048576).toFixed(1)} MiB, peak+${(out.peakDelta / 1048576).toFixed(1)} MiB (limit 32 MiB)`,
    );
    assert.equal(out.productSize, MAX_TOTAL_SIZE);
    assert.equal(out.productSha, out.expectedSha, "成品必须与原始素材一致");
    assert.ok(out.usedDelta < LIMIT, `heap+external growth exceeds 32 MiB`);
    assert.ok(out.peakDelta < LIMIT, `peak malloced growth exceeds 32 MiB`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
