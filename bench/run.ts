import { performance } from 'node:perf_hooks';
import { memoryUsage, resourceUsage } from 'node:process';
import { build } from '../src/index.js';
import { BENCH_SCALE, generateBenchData } from './generator.js';

function peakRssMiB(): number {
  // Node 的 resourceUsage().maxRSS 统一以 KiB 报告
  const fromRusage = resourceUsage().maxRSS / 2 ** 10;
  // 与查询结束时的当前 RSS 取较大者，避免平台单位差异导致低估
  const current = memoryUsage().rss / 2 ** 20;
  return Math.max(fromRusage, current);
}

function main(): void {
  const seed = Number(process.argv[2] ?? 20261006);
  console.log(`seed=${seed}`);
  const data = generateBenchData(seed);

  const t0 = performance.now();
  const searcher = build(data.pages, data.synonyms);
  const buildMs = performance.now() - t0;

  console.log(`pages=${BENCH_SCALE.pageCount} vocab<=${BENCH_SCALE.vocabSize + 1} ` +
    `edges=${data.synonyms.length} tokens=${data.stats.totalTokens}`);
  console.log(`pagesWithCommonWord=${data.stats.pagesWithCommonWord} ` +
    `(${(100 * data.stats.pagesWithCommonWord) / BENCH_SCALE.pageCount}%)`);
  console.log(`build=${buildMs.toFixed(0)}ms (不计入查询指标)`);

  // 预热若干次（不计时），随后 50 个不同查询各测一次；组件无结果缓存
  for (let i = 0; i < 5; i++) searcher.search(data.queries[i]!, 20);
  const latencies: number[] = [];
  let totalHits = 0;
  for (const q of data.queries) {
    const start = performance.now();
    const res = searcher.search(q, 20);
    latencies.push(performance.now() - start);
    totalHits += res.length;
    for (let i = 1; i < res.length; i++) {
      const a = res[i - 1]!;
      const b = res[i]!;
      if (a.score < b.score || (a.score === b.score && a.id > b.id)) {
        throw new Error('结果未按分数降序、id升序排列');
      }
    }
  }
  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)]!;
  const p95 = latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1)]!;
  const max = latencies[latencies.length - 1]!;
  const mean = latencies.reduce((s, x) => s + x, 0) / latencies.length;

  console.log(`queries=${latencies.length} totalHits=${totalHits}`);
  console.log(`latency ms: mean=${mean.toFixed(1)} p50=${p50.toFixed(1)} ` +
    `p95=${p95.toFixed(1)} max=${max.toFixed(1)}`);
  console.log(`peakRSS=${peakRssMiB().toFixed(0)} MiB (上限 512 MiB)`);
  if (p95 > 200) {
    console.error('P95 超过 200ms');
    process.exitCode = 1;
  }
  if (peakRssMiB() > 512) {
    console.error('峰值 RSS 超过 512 MiB');
    process.exitCode = 1;
  }
}

main();
