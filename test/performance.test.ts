import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RuleEngine } from '../src/index.ts';
import type { Rule, TrafficRecord } from '../src/index.ts';

const MIB = 1024 * 1024;

/** 确定性伪随机数（mulberry32），保证测试可复现。 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomIp(rand: () => number): string {
  const a = Math.floor(rand() * 256);
  const b = Math.floor(rand() * 256);
  const c = Math.floor(rand() * 256);
  const d = Math.floor(rand() * 256);
  return `${a}.${b}.${c}.${d}`;
}

/**
 * 构造 2000 条规则：协议集中在 TCP，网段在 10.0.0.0/8 内大量交叠，
 * 端口区间随机交叠；最后一条为优先级最差的兜底规则（末位命中目标）。
 */
function buildRules(): Rule[] {
  const rand = mulberry32(42);
  const rules: Rule[] = [];
  for (let i = 1; i <= 1999; i++) {
    const prefix = 8 + Math.floor(rand() * 25); // /8 .. /32
    const hostBits = 32 - prefix;
    const network = (0x0a000000 + Math.floor(rand() * 0x01000000)) >>> 0;
    const masked = network & (hostBits === 32 ? 0 : (~0 << hostBits));
    const cidr = [
      (masked >>> 24) & 0xff,
      (masked >>> 16) & 0xff,
      (masked >>> 8) & 0xff,
      masked & 0xff,
    ].join('.') + `/${prefix}`;
    const start = Math.floor(rand() * 65536);
    const end = Math.min(65535, start + Math.floor(rand() * 20000));
    rules.push({
      id: i,
      priority: (i % 1000) + 1,
      cidr,
      protocol: 'TCP',
      port: { start, end },
      action: 'DROP',
    });
  }
  // 兜底规则：优先级数字最大、编号最大，任何并列都输，只有它能命中末位流量。
  rules.push({
    id: 2000,
    priority: 1000,
    cidr: '0.0.0.0/0',
    protocol: 'TCP',
    port: 'ANY',
    action: 'RATE_LIMIT',
  });
  return rules;
}

/** 生成一批流量：一半 TCP 末位命中兜底规则，一半 UDP 完全不匹配。 */
function buildBatch(rand: () => number): TrafficRecord[] {
  const batch: TrafficRecord[] = new Array(10000);
  for (let i = 0; i < 10000; i++) {
    if (i % 2 === 0) {
      // 避开 10.0.0.0/8，确保不命中前 1999 条规则，只能末位命中兜底规则。
      let a = Math.floor(rand() * 256);
      if (a === 10) {
        a = 11;
      }
      batch[i] = {
        sourceIp: `${a}.${Math.floor(rand() * 256)}.${Math.floor(rand() * 256)}.${Math.floor(rand() * 256)}`,
        protocol: 'TCP',
        destinationPort: Math.floor(rand() * 65536),
      };
    } else {
      // 没有任何 UDP 规则，必然无匹配。
      batch[i] = {
        sourceIp: randomIp(rand),
        protocol: 'UDP',
        destinationPort: Math.floor(rand() * 65536),
      };
    }
  }
  return batch;
}

function memoryFootprint(): number {
  const mem = process.memoryUsage();
  return mem.heapUsed + mem.arrayBuffers;
}

describe('满载性能（2000 规则 × 1000 批 × 10000 条）', () => {
  it('总裁决耗时与内存满足资源要求', { timeout: 120000 }, () => {
    const rules = buildRules();
    assert.equal(rules.length, 2000);
    const engine = new RuleEngine();

    const replaceStart = performance.now();
    engine.replaceRules(rules);
    const replaceMs = performance.now() - replaceStart;

    // 预热并触发行缓存构建，随后以 GC 后的状态作为内存基线。
    const warmRand = mulberry32(7);
    engine.judge(buildBatch(warmRand));
    globalThis.gc!();
    const memBefore = memoryFootprint();

    const rand = mulberry32(1234);
    let lastHitCount = 0;
    let noMatchCount = 0;
    const judgeStart = performance.now();
    for (let batchIndex = 0; batchIndex < 1000; batchIndex++) {
      const verdicts = engine.judge(buildBatch(rand));
      if (batchIndex === 999) {
        for (const v of verdicts) {
          if (v.ruleId === 2000) {
            lastHitCount++;
          } else if (v.ruleId === null) {
            noMatchCount++;
          }
        }
      }
    }
    const judgeMs = performance.now() - judgeStart;
    globalThis.gc!();
    const memAfter = memoryFootprint();
    const memGrowthMiB = (memAfter - memBefore) / MIB;

    console.log(`  [perf] 规则装载: ${replaceMs.toFixed(1)}ms`);
    console.log(`  [perf] 1000 批 × 10000 条总裁决耗时: ${judgeMs.toFixed(1)}ms`);
    console.log(`  [perf] 库持有数据内存增长: ${memGrowthMiB.toFixed(1)} MiB`);
    console.log(`  [perf] 末位命中(兜底规则) ${lastHitCount} 条, 无匹配 ${noMatchCount} 条`);

    // 末位命中与无匹配流量确实出现，场景有效。
    assert.ok(lastHitCount > 0, '应存在末位命中兜底规则的流量');
    assert.ok(noMatchCount > 0, '应存在无匹配流量');
    assert.ok(replaceMs < 2000, `单次整体替换 ${replaceMs.toFixed(1)}ms 超过 2s`);
    assert.ok(judgeMs < 15000, `总裁决耗时 ${judgeMs.toFixed(1)}ms 超过 15s`);
    assert.ok(memGrowthMiB < 128, `内存增长 ${memGrowthMiB.toFixed(1)} MiB 超过 128 MiB`);
  });
});
