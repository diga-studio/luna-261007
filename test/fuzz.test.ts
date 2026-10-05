import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdjudicationEngine } from '../src/engine';
import type { Decision, Rule, TrafficRecord } from '../src/types';
import { cidrToRange, parseIpv4 } from '../src/ipv4';

/** 与输入顺序无关的确定性伪随机数生成器 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomIp(rand: () => number): string {
  const v = Math.floor(rand() * 0x100000000) >>> 0;
  return `${(v >>> 24) & 255}.${(v >>> 16) & 255}.${(v >>> 8) & 255}.${v & 255}`;
}

/** 朴素参考实现：逐规则扫描，按 (priority, id) 取首个匹配 */
function bruteForce(rules: Rule[], record: TrafficRecord): Decision {
  const ip = parseIpv4(record.srcIp);
  let best: Rule | null = null;
  for (const rule of rules) {
    if (rule.protocol !== 'ANY' && rule.protocol !== record.protocol) continue;
    if (record.protocol === 'ICMP') {
      if (rule.port.kind !== 'any') continue;
    } else if (rule.port.kind === 'range') {
      const p = record.dstPort!;
      if (p < rule.port.from || p > rule.port.to) continue;
    }
    const [s, e] = cidrToRange(rule.cidr);
    if (ip < s || ip > e) continue;
    if (
      best === null ||
      rule.priority < best.priority ||
      (rule.priority === best.priority && rule.id < best.id)
    ) {
      best = rule;
    }
  }
  return best === null
    ? { action: 'allow', ruleId: null }
    : { action: best.action, ruleId: best.id };
}

test('随机规则与流量：索引裁决结果与朴素扫描一致', () => {
  const rand = mulberry32(20261006);
  const protocols = ['TCP', 'UDP', 'ICMP', 'ANY'] as const;
  const actions = ['allow', 'rate-limit', 'challenge', 'drop'] as const;

  for (let round = 0; round < 20; round++) {
    const ruleCount = 1 + Math.floor(rand() * 120);
    const rules: Rule[] = [];
    for (let i = 0; i < ruleCount; i++) {
      const prefix = Math.floor(rand() * 33); // /0../32
      const useRange = rand() < 0.6;
      const from = Math.floor(rand() * 65536);
      const to = from + Math.floor(rand() * (65536 - from));
      rules.push({
        id: 1000 + i,
        priority: 1 + Math.floor(rand() * 1000),
        cidr: `${randomIp(rand)}/${prefix}`,
        protocol: protocols[Math.floor(rand() * 4)],
        port: useRange ? { kind: 'range', from, to } : { kind: 'any' },
        action: actions[Math.floor(rand() * 4)],
      });
    }
    const engine = new AdjudicationEngine();
    engine.replaceRules(rules);

    const records: TrafficRecord[] = [];
    for (let i = 0; i < 300; i++) {
      const proto = protocols[Math.floor(rand() * 3)] as 'TCP' | 'UDP' | 'ICMP';
      // 一半流量源地址取自规则网段附近，提高命中率
      const srcIp =
        rand() < 0.5 && rules.length > 0
          ? (() => {
              const r = rules[Math.floor(rand() * rules.length)];
              const [s, e] = cidrToRange(r.cidr);
              const v = s + Math.floor(rand() * (e - s + 1));
              return `${(v >>> 24) & 255}.${(v >>> 16) & 255}.${(v >>> 8) & 255}.${v & 255}`;
            })()
          : randomIp(rand);
      if (proto === 'ICMP') {
        records.push({ srcIp, protocol: 'ICMP' });
      } else {
        records.push({
          srcIp,
          protocol: proto,
          dstPort: Math.floor(rand() * 65536),
        });
      }
    }

    const actual = engine.adjudicate(records);
    const expected = records.map((r) => bruteForce(rules, r));
    assert.deepEqual(actual, expected, `round ${round} mismatch`);
  }
});
