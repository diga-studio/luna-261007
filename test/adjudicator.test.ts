import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RuleEngine } from '../src/index.ts';
import type { Rule, TrafficRecord, Verdict } from '../src/index.ts';

function makeRule(partial: Partial<Rule> & { id: number }): Rule {
  return {
    priority: 500,
    cidr: '0.0.0.0/0',
    protocol: 'ANY',
    port: 'ANY',
    action: 'DROP',
    ...partial,
  };
}

describe('匹配条件与优先级', () => {
  it('/0 与 /32 交叠时按优先级而非网段具体程度裁决', () => {
    const engine = new RuleEngine();
    engine.replaceRules([
      makeRule({ id: 1, priority: 10, cidr: '0.0.0.0/0', action: 'RATE_LIMIT' }),
      makeRule({ id: 2, priority: 20, cidr: '10.1.2.3/32', action: 'DROP' }),
    ]);
    const [v] = engine.judge([{ sourceIp: '10.1.2.3', protocol: 'TCP', destinationPort: 80 }]);
    // 更具体的 /32 不自动获胜，优先级更小的 /0 规则获胜。
    assert.deepEqual(v, { ruleId: 1, action: 'RATE_LIMIT' });

    // 反转优先级后 /32 规则获胜。
    engine.replaceRules([
      makeRule({ id: 1, priority: 20, cidr: '0.0.0.0/0', action: 'RATE_LIMIT' }),
      makeRule({ id: 2, priority: 10, cidr: '10.1.2.3/32', action: 'DROP' }),
    ]);
    const [v2] = engine.judge([{ sourceIp: '10.1.2.3', protocol: 'TCP', destinationPort: 80 }]);
    assert.deepEqual(v2, { ruleId: 2, action: 'DROP' });
  });

  it('优先级相同时编号最小的规则获胜', () => {
    const engine = new RuleEngine();
    engine.replaceRules([
      makeRule({ id: 9, priority: 100, action: 'DROP' }),
      makeRule({ id: 3, priority: 100, action: 'CHALLENGE' }),
      makeRule({ id: 7, priority: 100, action: 'RATE_LIMIT' }),
    ]);
    const [v] = engine.judge([{ sourceIp: '1.2.3.4', protocol: 'UDP', destinationPort: 53 }]);
    assert.deepEqual(v, { ruleId: 3, action: 'CHALLENGE' });
  });

  it('端口区间包含两个端点', () => {
    const engine = new RuleEngine();
    engine.replaceRules([
      makeRule({ id: 1, priority: 10, port: { start: 8000, end: 9000 }, action: 'DROP' }),
    ]);
    const records: TrafficRecord[] = [
      { sourceIp: '1.1.1.1', protocol: 'TCP', destinationPort: 8000 },
      { sourceIp: '1.1.1.1', protocol: 'TCP', destinationPort: 9000 },
      { sourceIp: '1.1.1.1', protocol: 'TCP', destinationPort: 7999 },
      { sourceIp: '1.1.1.1', protocol: 'TCP', destinationPort: 9001 },
    ];
    const verdicts = engine.judge(records);
    assert.equal(verdicts[0]!.ruleId, 1);
    assert.equal(verdicts[1]!.ruleId, 1);
    assert.deepEqual(verdicts[2], { ruleId: null, action: 'ALLOW' });
    assert.deepEqual(verdicts[3], { ruleId: null, action: 'ALLOW' });
  });

  it('ICMP 无端口，只能命中端口条件为 ANY 的规则', () => {
    const engine = new RuleEngine();
    engine.replaceRules([
      // 高优先级但带端口条件：ICMP 不应命中。
      makeRule({ id: 1, priority: 10, protocol: 'ANY', port: { start: 0, end: 65535 }, action: 'DROP' }),
      makeRule({ id: 2, priority: 20, protocol: 'ICMP', port: 'ANY', action: 'CHALLENGE' }),
    ]);
    const [icmp] = engine.judge([{ sourceIp: '1.1.1.1', protocol: 'ICMP' }]);
    assert.deepEqual(icmp, { ruleId: 2, action: 'CHALLENGE' });
    // 同一源地址的 TCP 流量命中高优先级的带端口条件规则。
    const [tcp] = engine.judge([{ sourceIp: '1.1.1.1', protocol: 'TCP', destinationPort: 80 }]);
    assert.deepEqual(tcp, { ruleId: 1, action: 'DROP' });
  });

  it('协议条件必须匹配，ANY 匹配所有协议', () => {
    const engine = new RuleEngine();
    engine.replaceRules([
      makeRule({ id: 1, priority: 10, protocol: 'TCP', action: 'DROP' }),
      makeRule({ id: 2, priority: 20, protocol: 'ANY', action: 'RATE_LIMIT' }),
    ]);
    const verdicts = engine.judge([
      { sourceIp: '1.1.1.1', protocol: 'TCP', destinationPort: 80 },
      { sourceIp: '1.1.1.1', protocol: 'UDP', destinationPort: 80 },
    ]);
    assert.deepEqual(verdicts[0], { ruleId: 1, action: 'DROP' });
    assert.deepEqual(verdicts[1], { ruleId: 2, action: 'RATE_LIMIT' });
  });

  it('CIDR 主机位不影响网络范围', () => {
    const engine = new RuleEngine();
    engine.replaceRules([
      // 10.0.0.0/8 写成带主机位的 10.1.2.3/8，表示的范围不变。
      makeRule({ id: 1, priority: 10, cidr: '10.1.2.3/8', action: 'DROP' }),
    ]);
    const verdicts = engine.judge([
      { sourceIp: '10.0.0.1', protocol: 'TCP', destinationPort: 1 },
      { sourceIp: '10.255.255.255', protocol: 'TCP', destinationPort: 1 },
      { sourceIp: '11.0.0.1', protocol: 'TCP', destinationPort: 1 },
    ]);
    assert.equal(verdicts[0]!.ruleId, 1);
    assert.equal(verdicts[1]!.ruleId, 1);
    assert.deepEqual(verdicts[2], { ruleId: null, action: 'ALLOW' });
  });

  it('边界地址 0.0.0.0 与 255.255.255.255', () => {
    const engine = new RuleEngine();
    engine.replaceRules([
      makeRule({ id: 1, priority: 10, cidr: '0.0.0.0/0', port: { start: 0, end: 0 }, action: 'DROP' }),
      makeRule({ id: 2, priority: 10, cidr: '255.255.255.255/32', port: { start: 65535, end: 65535 }, action: 'CHALLENGE' }),
    ]);
    const verdicts = engine.judge([
      { sourceIp: '0.0.0.0', protocol: 'TCP', destinationPort: 0 },
      { sourceIp: '255.255.255.255', protocol: 'TCP', destinationPort: 65535 },
      { sourceIp: '255.255.255.255', protocol: 'TCP', destinationPort: 0 },
    ]);
    assert.deepEqual(verdicts[0], { ruleId: 1, action: 'DROP' });
    assert.deepEqual(verdicts[1], { ruleId: 2, action: 'CHALLENGE' });
    // 两条都匹配时按优先级再编号决胜：此处同优先级，id=1 获胜。
    assert.deepEqual(verdicts[2], { ruleId: 1, action: 'DROP' });
  });

  it('没有匹配规则时默认放行且不关联规则', () => {
    const engine = new RuleEngine();
    engine.replaceRules([
      makeRule({ id: 1, priority: 10, cidr: '192.168.0.0/16', protocol: 'UDP', port: { start: 53, end: 53 }, action: 'DROP' }),
    ]);
    const verdicts = engine.judge([
      { sourceIp: '192.168.1.1', protocol: 'TCP', destinationPort: 53 }, // 协议不符
      { sourceIp: '192.168.1.1', protocol: 'UDP', destinationPort: 54 }, // 端口不符
      { sourceIp: '10.0.0.1', protocol: 'UDP', destinationPort: 53 }, // 网段不符
      { sourceIp: '192.168.1.1', protocol: 'ICMP' }, // ICMP 不命中带端口条件的规则
    ]);
    for (const v of verdicts) {
      assert.deepEqual(v, { ruleId: null, action: 'ALLOW' });
    }
  });

  it('空规则集合全部默认放行', () => {
    const engine = new RuleEngine();
    engine.replaceRules([]);
    const verdicts = engine.judge([
      { sourceIp: '1.2.3.4', protocol: 'TCP', destinationPort: 80 },
      { sourceIp: '1.2.3.4', protocol: 'ICMP' },
    ]);
    assert.deepEqual(verdicts[0], { ruleId: null, action: 'ALLOW' });
    assert.deepEqual(verdicts[1], { ruleId: null, action: 'ALLOW' });
  });

  it('输出顺序与输入一致', () => {
    const engine = new RuleEngine();
    engine.replaceRules([
      makeRule({ id: 1, priority: 10, cidr: '10.0.0.0/8', action: 'DROP' }),
    ]);
    const records: TrafficRecord[] = [];
    for (let i = 0; i < 100; i++) {
      records.push({
        sourceIp: i % 2 === 0 ? '10.0.0.1' : '11.0.0.1',
        protocol: 'TCP',
        destinationPort: 80,
      });
    }
    const verdicts = engine.judge(records);
    assert.equal(verdicts.length, 100);
    for (let i = 0; i < 100; i++) {
      assert.equal(verdicts[i]!.ruleId, i % 2 === 0 ? 1 : null);
    }
  });
});

describe('整体替换规则集合', () => {
  it('删除遮挡规则后，被遮挡规则重新成为获胜规则', () => {
    const engine = new RuleEngine();
    engine.replaceRules([
      makeRule({ id: 1, priority: 10, cidr: '0.0.0.0/0', action: 'ALLOW' }),
      makeRule({ id: 2, priority: 20, cidr: '10.0.0.0/8', action: 'DROP' }),
    ]);
    const before: Verdict = engine.judge([{ sourceIp: '10.0.0.1', protocol: 'TCP', destinationPort: 80 }])[0]!;
    assert.deepEqual(before, { ruleId: 1, action: 'ALLOW' });

    // 删除遮挡规则后，原先被遮挡的规则 2 获胜。
    engine.replaceRules([
      makeRule({ id: 2, priority: 20, cidr: '10.0.0.0/8', action: 'DROP' }),
    ]);
    const after = engine.judge([{ sourceIp: '10.0.0.1', protocol: 'TCP', destinationPort: 80 }])[0]!;
    assert.deepEqual(after, { ruleId: 2, action: 'DROP' });
  });

  it('修改遮挡规则（降低优先级）后，被遮挡规则成为获胜规则', () => {
    const engine = new RuleEngine();
    engine.replaceRules([
      makeRule({ id: 1, priority: 10, action: 'ALLOW' }),
      makeRule({ id: 2, priority: 20, action: 'DROP' }),
    ]);
    assert.equal(engine.judge([{ sourceIp: '1.1.1.1', protocol: 'TCP', destinationPort: 80 }])[0]!.ruleId, 1);

    // 把规则 1 的优先级改差（数字变大），规则 2 变为获胜者。
    engine.replaceRules([
      makeRule({ id: 1, priority: 30, action: 'ALLOW' }),
      makeRule({ id: 2, priority: 20, action: 'DROP' }),
    ]);
    const v = engine.judge([{ sourceIp: '1.1.1.1', protocol: 'TCP', destinationPort: 80 }])[0]!;
    assert.deepEqual(v, { ruleId: 2, action: 'DROP' });
  });

  it('替换后旧集合不再生效', () => {
    const engine = new RuleEngine();
    engine.replaceRules([makeRule({ id: 1, priority: 1, action: 'DROP' })]);
    engine.replaceRules([makeRule({ id: 2, priority: 1, cidr: '10.0.0.0/8', action: 'CHALLENGE' })]);
    const verdicts = engine.judge([
      { sourceIp: '10.0.0.1', protocol: 'TCP', destinationPort: 80 },
      { sourceIp: '192.168.0.1', protocol: 'TCP', destinationPort: 80 },
    ]);
    assert.deepEqual(verdicts[0], { ruleId: 2, action: 'CHALLENGE' });
    assert.deepEqual(verdicts[1], { ruleId: null, action: 'ALLOW' });
  });
});

describe('输入校验', () => {
  it('拒绝重复编号、越界优先级与非法端口区间', () => {
    const engine = new RuleEngine();
    assert.throws(() => engine.replaceRules([
      makeRule({ id: 1 }),
      makeRule({ id: 1 }),
    ]));
    assert.throws(() => engine.replaceRules([makeRule({ id: 1, priority: 0 })]));
    assert.throws(() => engine.replaceRules([makeRule({ id: 1, priority: 1001 })]));
    assert.throws(() => engine.replaceRules([makeRule({ id: 1, port: { start: 100, end: 99 } })]));
    assert.throws(() => engine.replaceRules([makeRule({ id: 1, port: { start: 0, end: 65536 } })]));
    assert.throws(() => engine.replaceRules([makeRule({ id: 1, cidr: '10.0.0.0/33' })]));
  });

  it('拒绝非法流量记录', () => {
    const engine = new RuleEngine();
    engine.replaceRules([makeRule({ id: 1 })]);
    assert.throws(() => engine.judge([{ sourceIp: '1.1.1.1', protocol: 'TCP' }]));
    assert.throws(() => engine.judge([{ sourceIp: '1.1.1.1', protocol: 'TCP', destinationPort: 65536 }]));
    assert.throws(() => engine.judge([{ sourceIp: '999.1.1.1', protocol: 'TCP', destinationPort: 80 }]));
  });
});
