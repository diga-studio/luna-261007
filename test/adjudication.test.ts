import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdjudicationEngine } from '../src/engine';
import type { Rule, TrafficRecord } from '../src/types';

function rule(partial: Partial<Rule> & { id: number }): Rule {
  return {
    priority: 500,
    cidr: '0.0.0.0/0',
    protocol: 'ANY',
    port: { kind: 'any' },
    action: 'drop',
    ...partial,
  };
}

test('/0 与 /32 交叠时按优先级裁决，而非网段具体程度', () => {
  const engine = new AdjudicationEngine();
  engine.replaceRules([
    rule({ id: 1, priority: 10, cidr: '0.0.0.0/0', action: 'challenge' }),
    rule({ id: 2, priority: 20, cidr: '10.1.2.3/32', action: 'drop' }),
  ]);
  const [d] = engine.adjudicate([
    { srcIp: '10.1.2.3', protocol: 'TCP', dstPort: 80 },
  ]);
  // 更具体的 /32 不会自动获胜，优先级数字最小者胜
  assert.deepEqual(d, { action: 'challenge', ruleId: 1 });
});

test('同优先级时编号最小者获胜', () => {
  const engine = new AdjudicationEngine();
  engine.replaceRules([
    rule({ id: 9, priority: 100, action: 'drop' }),
    rule({ id: 3, priority: 100, action: 'rate-limit' }),
    rule({ id: 7, priority: 100, action: 'challenge' }),
  ]);
  const [d] = engine.adjudicate([
    { srcIp: '1.2.3.4', protocol: 'UDP', dstPort: 53 },
  ]);
  assert.deepEqual(d, { action: 'rate-limit', ruleId: 3 });
});

test('端口区间包含两个端点', () => {
  const engine = new AdjudicationEngine();
  engine.replaceRules([
    rule({
      id: 1,
      priority: 10,
      protocol: 'TCP',
      port: { kind: 'range', from: 8000, to: 9000 },
      action: 'drop',
    }),
  ]);
  const records: TrafficRecord[] = [7999, 8000, 9000, 9001].map((p) => ({
    srcIp: '1.1.1.1',
    protocol: 'TCP',
    dstPort: p,
  }));
  const decisions = engine.adjudicate(records);
  assert.deepEqual(
    decisions.map((d) => d.ruleId),
    [null, 1, 1, null],
  );
  assert.equal(decisions[0].action, 'allow');
  assert.equal(decisions[3].action, 'allow');
});

test('ICMP 记录无端口，只命中端口条件为任意的规则', () => {
  const engine = new AdjudicationEngine();
  engine.replaceRules([
    rule({
      id: 1,
      priority: 10,
      protocol: 'ANY',
      port: { kind: 'range', from: 0, to: 65535 },
      action: 'drop',
    }),
    rule({
      id: 2,
      priority: 20,
      protocol: 'ICMP',
      port: { kind: 'any' },
      action: 'challenge',
    }),
  ]);
  // 端口区间规则即使覆盖全部端口，也不能命中无端口的 ICMP 记录
  const [d] = engine.adjudicate([{ srcIp: '1.1.1.1', protocol: 'ICMP' }]);
  assert.deepEqual(d, { action: 'challenge', ruleId: 2 });
});

test('CIDR 主机位不影响网络范围', () => {
  const engine = new AdjudicationEngine();
  engine.replaceRules([
    rule({ id: 1, priority: 10, cidr: '10.9.9.9/8', action: 'drop' }),
  ]);
  const decisions = engine.adjudicate([
    { srcIp: '10.0.0.0', protocol: 'TCP', dstPort: 1 },
    { srcIp: '10.255.255.255', protocol: 'TCP', dstPort: 1 },
    { srcIp: '11.0.0.0', protocol: 'TCP', dstPort: 1 },
  ]);
  assert.deepEqual(
    decisions.map((d) => d.ruleId),
    [1, 1, null],
  );
});

test('地址边界 0.0.0.0 与 255.255.255.255', () => {
  const engine = new AdjudicationEngine();
  engine.replaceRules([
    rule({ id: 1, priority: 10, cidr: '0.0.0.0/0', action: 'rate-limit' }),
  ]);
  const decisions = engine.adjudicate([
    { srcIp: '0.0.0.0', protocol: 'UDP', dstPort: 0 },
    { srcIp: '255.255.255.255', protocol: 'UDP', dstPort: 65535 },
  ]);
  assert.deepEqual(
    decisions.map((d) => d.ruleId),
    [1, 1],
  );
});

test('无匹配规则时默认放行且不关联规则', () => {
  const engine = new AdjudicationEngine();
  engine.replaceRules([
    rule({ id: 1, priority: 10, cidr: '192.168.0.0/16', action: 'drop' }),
  ]);
  const [d] = engine.adjudicate([
    { srcIp: '8.8.8.8', protocol: 'TCP', dstPort: 443 },
  ]);
  assert.deepEqual(d, { action: 'allow', ruleId: null });
});

test('整体替换后只使用新集合；删除遮挡规则后被遮挡规则生效', () => {
  const engine = new AdjudicationEngine();
  engine.replaceRules([
    rule({ id: 1, priority: 10, cidr: '0.0.0.0/0', action: 'drop' }),
    rule({ id: 2, priority: 20, cidr: '10.0.0.0/8', action: 'challenge' }),
  ]);
  let [d] = engine.adjudicate([
    { srcIp: '10.1.1.1', protocol: 'TCP', dstPort: 80 },
  ]);
  assert.deepEqual(d, { action: 'drop', ruleId: 1 });

  // 删除高优先级遮挡规则后，被遮挡的规则 2 成为获胜规则
  engine.replaceRules([
    rule({ id: 2, priority: 20, cidr: '10.0.0.0/8', action: 'challenge' }),
  ]);
  [d] = engine.adjudicate([
    { srcIp: '10.1.1.1', protocol: 'TCP', dstPort: 80 },
  ]);
  assert.deepEqual(d, { action: 'challenge', ruleId: 2 });
});

test('修改遮挡规则的网段后，原位置由被遮挡规则裁决', () => {
  const engine = new AdjudicationEngine();
  engine.replaceRules([
    rule({ id: 1, priority: 10, cidr: '10.0.0.0/8', action: 'drop' }),
    rule({ id: 2, priority: 20, cidr: '10.0.0.0/8', action: 'challenge' }),
  ]);
  // 把规则 1 改到别的网段，规则 2 重新参与并获胜
  engine.replaceRules([
    rule({ id: 1, priority: 10, cidr: '192.168.0.0/16', action: 'drop' }),
    rule({ id: 2, priority: 20, cidr: '10.0.0.0/8', action: 'challenge' }),
  ]);
  const [d] = engine.adjudicate([
    { srcIp: '10.5.5.5', protocol: 'TCP', dstPort: 22 },
  ]);
  assert.deepEqual(d, { action: 'challenge', ruleId: 2 });
});

test('批量裁决输出顺序与输入一致', () => {
  const engine = new AdjudicationEngine();
  engine.replaceRules([
    rule({ id: 1, priority: 10, cidr: '10.0.0.0/8', action: 'drop' }),
  ]);
  const records: TrafficRecord[] = [
    { srcIp: '8.8.8.8', protocol: 'TCP', dstPort: 1 },
    { srcIp: '10.0.0.1', protocol: 'TCP', dstPort: 1 },
    { srcIp: '9.9.9.9', protocol: 'ICMP' },
    { srcIp: '10.0.0.2', protocol: 'UDP', dstPort: 2 },
  ];
  const decisions = engine.adjudicate(records);
  assert.equal(decisions.length, 4);
  assert.deepEqual(
    decisions.map((d) => d.ruleId),
    [null, 1, null, 1],
  );
});

test('协议条件：ANY 命中所有协议，具体协议只命中对应记录', () => {
  const engine = new AdjudicationEngine();
  engine.replaceRules([
    rule({ id: 1, priority: 10, protocol: 'TCP', action: 'drop' }),
    rule({ id: 2, priority: 20, protocol: 'ANY', action: 'challenge' }),
  ]);
  const decisions = engine.adjudicate([
    { srcIp: '1.1.1.1', protocol: 'TCP', dstPort: 80 },
    { srcIp: '1.1.1.1', protocol: 'UDP', dstPort: 80 },
    { srcIp: '1.1.1.1', protocol: 'ICMP' },
  ]);
  assert.deepEqual(
    decisions.map((d) => d.ruleId),
    [1, 2, 2],
  );
});

test('非法规则集合被拒绝', () => {
  const engine = new AdjudicationEngine();
  assert.throws(() =>
    engine.replaceRules([
      rule({ id: 1 }),
      rule({ id: 1, cidr: '1.0.0.0/8' }),
    ]),
  );
  assert.throws(() => engine.replaceRules([rule({ id: 1, priority: 0 })]));
  assert.throws(() => engine.replaceRules([rule({ id: 1, priority: 1001 })]));
  assert.throws(() =>
    engine.replaceRules([
      rule({ id: 1, port: { kind: 'range', from: 100, to: 99 } }),
    ]),
  );
});
