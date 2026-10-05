import type { Decision, Rule, TrafficRecord } from './types';
import { parseIpv4 } from './ipv4';
import { ProtocolIndex } from './protocolIndex';

/** DDoS 防护规则裁决引擎。规则与索引全部驻留进程内存，不执行真实流量处置。 */
export class AdjudicationEngine {
  private rules: Rule[] = [];
  private readonly tcpIndex = new ProtocolIndex(true);
  private readonly udpIndex = new ProtocolIndex(true);
  private readonly icmpIndex = new ProtocolIndex(false);

  /** 整体替换活动规则集合；后续裁决只使用新集合 */
  replaceRules(rules: Rule[]): void {
    validateRules(rules);
    this.rules = rules.slice();
    // 按记录协议分组：协议条件为 ANY 的规则同时进入 TCP/UDP/ICMP 组
    const tcp: Rule[] = [];
    const udp: Rule[] = [];
    const icmp: Rule[] = [];
    for (const rule of this.rules) {
      if (rule.protocol === 'TCP' || rule.protocol === 'ANY') tcp.push(rule);
      if (rule.protocol === 'UDP' || rule.protocol === 'ANY') udp.push(rule);
      if (rule.protocol === 'ICMP' || rule.protocol === 'ANY') icmp.push(rule);
    }
    this.tcpIndex.build(tcp);
    this.udpIndex.build(udp);
    this.icmpIndex.build(icmp);
    // 各组内规则数组与全局规则数组下标不同，需要映射：保存分组数组引用
    this.tcpRules = tcp;
    this.udpRules = udp;
    this.icmpRules = icmp;
  }

  private tcpRules: Rule[] = [];
  private udpRules: Rule[] = [];
  private icmpRules: Rule[] = [];

  /** 逐条裁决一批流量记录，输出顺序与输入一致 */
  adjudicate(records: TrafficRecord[]): Decision[] {
    const out = new Array<Decision>(records.length);
    for (let i = 0; i < records.length; i++) {
      out[i] = this.decide(records[i]);
    }
    return out;
  }

  private decide(record: TrafficRecord): Decision {
    const ip = parseIpv4(record.srcIp);
    let hit = -1;
    let rule: Rule | undefined;
    switch (record.protocol) {
      case 'TCP': {
        const port = requirePort(record);
        hit = this.tcpIndex.query(ip, port);
        if (hit >= 0) rule = this.tcpRules[hit];
        break;
      }
      case 'UDP': {
        const port = requirePort(record);
        hit = this.udpIndex.query(ip, port);
        if (hit >= 0) rule = this.udpRules[hit];
        break;
      }
      case 'ICMP': {
        hit = this.icmpIndex.query(ip, 0);
        if (hit >= 0) rule = this.icmpRules[hit];
        break;
      }
      default:
        throw new Error(`unknown protocol: ${String(record.protocol)}`);
    }
    if (rule === undefined) {
      return { action: 'allow', ruleId: null };
    }
    return { action: rule.action, ruleId: rule.id };
  }
}

function requirePort(record: TrafficRecord): number {
  const port = record.dstPort;
  if (
    port === undefined ||
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65535
  ) {
    throw new Error(
      `${record.protocol} record requires dstPort in 0..65535, got ${String(port)}`,
    );
  }
  return port;
}

function validateRules(rules: Rule[]): void {
  const seen = new Set<number>();
  for (const rule of rules) {
    if (!Number.isInteger(rule.id)) {
      throw new Error(`rule id must be an integer, got ${String(rule.id)}`);
    }
    if (seen.has(rule.id)) {
      throw new Error(`duplicate rule id: ${rule.id}`);
    }
    seen.add(rule.id);
    if (
      !Number.isInteger(rule.priority) ||
      rule.priority < 1 ||
      rule.priority > 1000
    ) {
      throw new Error(
        `rule ${rule.id}: priority must be an integer in 1..1000, got ${String(rule.priority)}`,
      );
    }
    if (rule.port.kind === 'range') {
      const { from, to } = rule.port;
      if (
        !Number.isInteger(from) ||
        !Number.isInteger(to) ||
        from < 0 ||
        to > 65535 ||
        from > to
      ) {
        throw new Error(
          `rule ${rule.id}: invalid port range [${String(from)}, ${String(to)}]`,
        );
      }
    }
  }
}
