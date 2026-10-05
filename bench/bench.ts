import { performance } from "node:perf_hooks";
import { memoryUsage } from "node:process";
import { build } from "../src/index.js";
import { generateScaleData } from "./generator.js";

function currentRssMiB(): number {
  return memoryUsage().rss / (1024 * 1024);
}

/** Peak RSS is tracked by sampling at each phase boundary. */
let peakRssMiB = 0;
function sampleRss(): number {
  const rss = currentRssMiB();
  if (rss > peakRssMiB) peakRssMiB = rss;
  return rss;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

function main(): void {
  const seed = Number(process.argv[2] ?? 42);
  console.log(`generating scale data (seed=${seed}) ...`);
  const data = generateScaleData(seed);
  sampleRss();
  console.log(
    `stats: pages=${data.stats.pageCount} tokens=${data.stats.tokenCount} ` +
      `vocab=${data.stats.vocabSize} edges=${data.stats.edgeCount} ` +
      `hotWordPages=${data.stats.hotWordPages}`,
  );

  const t0 = performance.now();
  const retriever = build(data.pages, data.synonyms);
  const buildMs = performance.now() - t0;
  console.log(`build: ${buildMs.toFixed(0)} ms (excluded from query metrics)`);
  globalThis.gc?.();
  console.log(`rss after build: ${sampleRss().toFixed(1)} MiB`);

  // Warm-up: one throwaway query per distinct rare word shape is NOT used;
  // all 50 timed queries are distinct and no result cache exists.
  const latencies: number[] = [];
  let totalHits = 0;
  for (const query of data.queries) {
    const start = performance.now();
    const hits = retriever.search(query, 20);
    latencies.push(performance.now() - start);
    totalHits += hits.length;
    sampleRss();
    // Sanity: hits must be sorted by (score desc, id asc) with unique ids.
    for (let i = 1; i < hits.length; i++) {
      const a = hits[i - 1]!;
      const b = hits[i]!;
      if (a.score < b.score || (a.score === b.score && a.id >= b.id)) {
        throw new Error(`result ordering violated at query ${JSON.stringify(query)}`);
      }
    }
  }
  latencies.sort((a, b) => a - b);
  console.log(`queries: ${latencies.length} distinct, total hits returned: ${totalHits}`);
  console.log(
    `latency ms: p50=${percentile(latencies, 50).toFixed(2)} ` +
      `p95=${percentile(latencies, 95).toFixed(2)} ` +
      `max=${latencies[latencies.length - 1]!.toFixed(2)}`,
  );
  console.log(`peak RSS (sampled): ${peakRssMiB.toFixed(1)} MiB`);

  const p95 = percentile(latencies, 95);
  if (p95 > 200) {
    console.error(`FAIL: p95 ${p95.toFixed(2)} ms exceeds 200 ms`);
    process.exitCode = 1;
  }
  if (peakRssMiB > 512) {
    console.error(`FAIL: peak RSS ${peakRssMiB.toFixed(1)} MiB exceeds 512 MiB`);
    process.exitCode = 1;
  }
}

main();
