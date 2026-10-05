import { cidrToRange, parseIpv4 } from './ip.ts';
import type { Action, Rule, TrafficRecord, Verdict } from './types.ts';

/** 行缓存中“无匹配规则”的哨兵值（规则在有序数组中的位置最大为 1999，不会冲突）。 */
const NONE = 0xffff;

const PROTO_TCP = 1;
const PROTO_UDP = 2;
const PROTO_ICMP = 4;

const PROTOCOL_MASK: Record<string, number> = {
  TCP: PROTO_TCP,
  UDP: PROTO_UDP,
  ICMP: PROTO_ICMP,
  ANY: PROTO_TCP | PROTO_UDP | PROTO_ICMP,
};

const VALID_ACTIONS = new Set(['ALLOW', 'RATE_LIMIT', 'CHALLENGE', 'DROP']);

/** 归一化后的规则：数值字段均已展开为可比较的整数。 */
interface NormRule {
  readonly id: number;
  readonly priority: number;
  readonly action: Action;
  readonly ipStart: number;
  readonly ipEnd: number;
  readonly protoMask: number;
  /** 端口条件是否为 ANY（ICMP 只能命中此类规则）。 */
  readonly portAny: boolean;
  readonly portStart: number;
  readonly portEnd: number;
}

/** 在已排序无重复数组中找最后一个小于等于 value 的下标，不存在则返回 -1。 */
function upperBoundMinus1(sorted: ArrayLike<number>, value: number): number {
  let lo = 0;
  let hi = sorted.length; // 不变式：sorted[lo-1] <= value < sorted[hi]
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]! <= value) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo - 1;
}

/** 在已排序数组中找第一个大于等于 value 的下标。 */
function lowerBound(sorted: ArrayLike<number>, value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]! < value) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/** 并查集 find（带路径压缩），用于行内未填充端口段的快速跳转。 */
function findRoot(next: Int32Array, x: number): number {
  let root = x;
  while (next[root]! !== root) {
    root = next[root]!;
  }
  while (next[x]! !== root) {
    const parent = next[x]!;
    next[x] = root;
    x = parent;
  }
  return root;
}

function normalizeRule(rule: Rule): NormRule {
  if (!Number.isInteger(rule.id)) {
    throw new Error(`rule id must be an integer: ${String(rule.id)}`);
  }
  if (!Number.isInteger(rule.priority) || rule.priority < 1 || rule.priority > 1000) {
    throw new Error(`rule ${rule.id}: priority must be an integer in 1..1000`);
  }
  const protoMask = PROTOCOL_MASK[rule.protocol];
  if (protoMask === undefined) {
    throw new Error(`rule ${rule.id}: invalid protocol ${String(rule.protocol)}`);
  }
  if (!VALID_ACTIONS.has(rule.action)) {
    throw new Error(`rule ${rule.id}: invalid action ${String(rule.action)}`);
  }
  const [ipStart, ipEnd] = cidrToRange(rule.cidr);
  let portAny: boolean;
  let portStart: number;
  let portEnd: number;
  if (rule.port === 'ANY') {
    portAny = true;
    portStart = 0;
    portEnd = 65535;
  } else {
    const { start, end } = rule.port;
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end > 65535 ||
      start > end
    ) {
      throw new Error(`rule ${rule.id}: invalid port range`);
    }
    portAny = false;
    portStart = start;
    portEnd = end;
  }
  return { id: rule.id, priority: rule.priority, action: rule.action, ipStart, ipEnd, protoMask, portAny, portStart, portEnd };
}

/**
 * DDoS 防护规则裁决引擎。规则与索引全部保存在进程内存中。
 *
 * 索引结构：把规则集合的网段边界与端口边界分别离散化为基本区间，
 * 查询时先二分定位 IP 段，再按协议查“该 IP 段 × 各端口段”的获胜规则行。
 * 行按懒加载计算并缓存，替换规则集合时全部失效。
 */
export class RuleEngine {
  private sortedRules: NormRule[] = [];
  private ipBounds: number[] = [];
  private portBounds: number[] = [0, 65536];
  private tcpRows: Array<Uint16Array | undefined> = [];
  private udpRows: Array<Uint16Array | undefined> = [];
  private icmpWinners: Uint16Array = new Uint16Array(0);
  private scratch: Int32Array = new Int32Array(0);

  /** 整体替换活动规则集合。 */
  replaceRules(rules: readonly Rule[]): void {
    const seen = new Set<number>();
    const normalized: NormRule[] = new Array(rules.length);
    for (let i = 0; i < rules.length; i++) {
      const rule = normalizeRule(rules[i]!);
      if (seen.has(rule.id)) {
        throw new Error(`duplicate rule id: ${rule.id}`);
      }
      seen.add(rule.id);
      normalized[i] = rule;
    }
    // 获胜顺序：优先级数字小者优先；并列时编号小者优先。
    normalized.sort((a, b) => a.priority - b.priority || a.id - b.id);

    const ipCuts = new Set<number>();
    const portCuts = new Set<number>([0, 65536]);
    for (const rule of normalized) {
      ipCuts.add(rule.ipStart);
      ipCuts.add(rule.ipEnd + 1);
      if (!rule.portAny) {
        portCuts.add(rule.portStart);
        portCuts.add(rule.portEnd + 1);
      }
    }
    const ipBounds = [...ipCuts].sort((a, b) => a - b);
    const portBounds = [...portCuts].sort((a, b) => a - b);

    this.sortedRules = normalized;
    this.ipBounds = ipBounds;
    this.portBounds = portBounds;
    const segmentCount = Math.max(ipBounds.length - 1, 0);
    this.tcpRows = new Array(segmentCount);
    this.udpRows = new Array(segmentCount);
    this.icmpWinners = new Uint16Array(segmentCount);
    this.scratch = new Int32Array(portBounds.length);

    // ICMP 没有端口维度，按 IP 段直接预算获胜者。
    for (let seg = 0; seg < segmentCount; seg++) {
      this.icmpWinners[seg] = this.computeIcmpWinner(seg);
    }
  }

  /** 对一批流量逐条裁决，输出顺序与输入一致。 */
  judge(records: readonly TrafficRecord[]): Verdict[] {
    const verdicts = new Array<Verdict>(records.length);
    const segmentCount = this.icmpWinners.length;
    for (let i = 0; i < records.length; i++) {
      const record = records[i]!;
      let winner = NONE;
      if (segmentCount > 0) {
        const ip = parseIpv4(record.sourceIp);
        const seg = upperBoundMinus1(this.ipBounds, ip);
        if (seg >= 0 && seg < segmentCount) {
          if (record.protocol === 'ICMP') {
            winner = this.icmpWinners[seg]!;
          } else {
            const port = record.destinationPort;
            if (
              port === undefined ||
              !Number.isInteger(port) ||
              port < 0 ||
              port > 65535
            ) {
              throw new Error(`record ${i}: TCP/UDP record requires destinationPort in 0..65535`);
            }
            const mask = record.protocol === 'TCP' ? PROTO_TCP : PROTO_UDP;
            const rows = record.protocol === 'TCP' ? this.tcpRows : this.udpRows;
            let row = rows[seg];
            if (row === undefined) {
              row = this.computeRow(mask, seg);
              rows[seg] = row;
            }
            const portSeg = upperBoundMinus1(this.portBounds, port);
            winner = row[portSeg]!;
          }
        }
      }
      verdicts[i] = this.toVerdict(winner);
    }
    return verdicts;
  }

  private toVerdict(winner: number): Verdict {
    if (winner === NONE) {
      return { ruleId: null, action: 'ALLOW' };
    }
    const rule = this.sortedRules[winner]!;
    return { ruleId: rule.id, action: rule.action };
  }

  /** ICMP 段获胜者：只看协议匹配且端口条件为 ANY 的规则，按有序顺序取第一条。 */
  private computeIcmpWinner(seg: number): number {
    const segStart = this.ipBounds[seg]!;
    const segEnd = this.ipBounds[seg + 1]! - 1;
    const rules = this.sortedRules;
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i]!;
      if ((rule.protoMask & PROTO_ICMP) === 0 || !rule.portAny) {
        continue;
      }
      if (rule.ipStart <= segStart && rule.ipEnd >= segEnd) {
        return i;
      }
    }
    return NONE;
  }

  /**
   * 计算某个 IP 基本区间在指定协议下的“端口段 → 获胜规则位置”行。
   * 按获胜顺序扫描覆盖该段的规则，用并查集跳过已填充的端口段，
   * 每个端口段只会被写入一次。
   */
  private computeRow(mask: number, seg: number): Uint16Array {
    const segStart = this.ipBounds[seg]!;
    const segEnd = this.ipBounds[seg + 1]! - 1;
    const portSegCount = this.portBounds.length - 1;
    const row = new Uint16Array(portSegCount).fill(NONE);
    const next = this.scratch;
    for (let i = 0; i <= portSegCount; i++) {
      next[i] = i;
    }
    let painted = 0;
    const rules = this.sortedRules;
    for (let r = 0; r < rules.length && painted < portSegCount; r++) {
      const rule = rules[r]!;
      if ((rule.protoMask & mask) === 0) {
        continue;
      }
      if (rule.ipStart > segStart || rule.ipEnd < segEnd) {
        continue;
      }
      const portStartSeg = lowerBound(this.portBounds, rule.portStart);
      const portEndSeg = upperBoundMinus1(this.portBounds, rule.portEnd);
      let cell = findRoot(next, portStartSeg);
      while (cell <= portEndSeg) {
        row[cell] = r;
        painted++;
        next[cell] = findRoot(next, cell + 1);
        cell = next[cell]!;
      }
    }
    return row;
  }
}
