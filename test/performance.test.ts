import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdjudicationEngine } from '../src/engine';
import type { Rule, TrafficRecord } from '../src/types';

const RULE_COUNT = 2000;
const BATCH_SIZE = 10000;
const BATCH_COUNT = 1000;
const ADJUDICATE_BUDGET_MS = 15000;
const REPLACE_BUDGET_MS = 2000;
const MEMORY_BUDGET_BYTES = 128 * 1024 * 1024;

/**
 * 满载最坏场景：
 * - 2000 条规则全部集中在 TCP；
 * - 1000 条 0.0.0.0/0 与 1000 条 /32 造成网段大量交叠；
 * - /0 规则端口区间端点互不相同，最大化每网段的端口胜者表；
 * - 流量一半集中命中优先级最低的规则，一半完全不匹配。
 */
function buildRules(): Rule[] {
  const rules: Rule[] = [];
  for (let i = 0; i < 999; i++) {
    rules.push({
      id: i + 1,
      priority: (i % 999) + 1,
      cidr: '0.0.0.0/0',
      protocol: 'TCP',
      port: { kind: 'range', from: i % 5000, to: 30000 + i },
      action: 'rate-limit',
    });
  }
  // 优先级最低（数字最大）的规则：独占端口 65535
  rules.push({
    id: 1000,
    priority: 1000,
    cidr: '0.0.0.0/0',
    protocol: 'TCP',
    port: { kind: 'range', from: 65535, to: 65535 },
    action: 'drop',
  });
  // 1000 条互不相同的 /32，与 /0 规则交叠
  for (let i = 0; i < 1000; i++) {
    rules.push({
      id: 1001 + i,
      priority: (i % 1000) + 1,
      cidr: `10.${(i >> 8) & 255}.${i & 255}.7/32`,
      protocol: 'TCP',
      port: { kind: 'any' },
      action: 'challenge',
    });
  }
  return rules;
}

function buildBatch(): TrafficRecord[] {
  const records: TrafficRecord[] = [];
  for (let i = 0; i < BATCH_SIZE; i++) {
    if (i % 2 === 0) {
      // 命中最低优先级规则（id=1000，priority=1000）
      records.push({ srcIp: '9.1.2.3', protocol: 'TCP', dstPort: 65535 });
    } else {
      // 无匹配：源地址不在任何 /32 内，端口不被任何 /0 规则覆盖
      records.push({ srcIp: '9.4.5.6', protocol: 'TCP', dstPort: 61000 });
    }
  }
  return records;
}

/** 库持有内存近似量：JS 堆 + 类型数组底层缓冲 */
function libMemory(): number {
  if (typeof global.gc === 'function') {
    global.gc();
    global.gc();
  }
  const m = process.memoryUsage();
  return m.heapUsed + m.arrayBuffers;
}

test('满载：2000 规则交叠，1000 批 × 10000 条，末位命中与无匹配', () => {
  const engine = new AdjudicationEngine();
  const rules = buildRules();
  assert.equal(rules.length, RULE_COUNT);

  const memBefore = libMemory();
  const replaceStart = Date.now();
  engine.replaceRules(rules);
  const replaceMs = Date.now() - replaceStart;
  const memAfterReplace = libMemory();

  // 裁决结果抽查：末位命中与无匹配
  const probe = engine.adjudicate([
    { srcIp: '9.1.2.3', protocol: 'TCP', dstPort: 65535 },
    { srcIp: '9.4.5.6', protocol: 'TCP', dstPort: 61000 },
  ]);
  assert.deepEqual(probe[0], { action: 'drop', ruleId: 1000 });
  assert.deepEqual(probe[1], { action: 'allow', ruleId: null });

  const batch = buildBatch();
  const adjStart = Date.now();
  for (let b = 0; b < BATCH_COUNT; b++) {
    const decisions = engine.adjudicate(batch);
    assert.equal(decisions.length, BATCH_SIZE);
  }
  const adjMs = Date.now() - adjStart;
  const memAfterBatches = libMemory();
  const memDelta = Math.max(
    memAfterReplace - memBefore,
    memAfterBatches - memBefore,
  );

  console.log(
    `  [perf] replace=${replaceMs}ms (<= ${REPLACE_BUDGET_MS}ms), ` +
      `adjudicate ${BATCH_COUNT}x${BATCH_SIZE}=${adjMs}ms (<= ${ADJUDICATE_BUDGET_MS}ms), ` +
      `heap delta=${(memDelta / 1024 / 1024).toFixed(1)} MiB (<= 128 MiB)`,
  );
  assert.ok(
    replaceMs <= REPLACE_BUDGET_MS,
    `replaceRules took ${replaceMs}ms`,
  );
  assert.ok(
    adjMs <= ADJUDICATE_BUDGET_MS,
    `adjudication took ${adjMs}ms`,
  );
  assert.ok(
    memDelta <= MEMORY_BUDGET_BYTES,
    `memory delta ${(memDelta / 1024 / 1024).toFixed(1)} MiB`,
  );
});
