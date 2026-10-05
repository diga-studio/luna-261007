/** 协议条件。 */
export type Protocol = 'TCP' | 'UDP' | 'ICMP';

/** 规则动作。 */
export type Action = 'ALLOW' | 'RATE_LIMIT' | 'CHALLENGE' | 'DROP';

/** 目的端口闭区间，两个端点均包含。 */
export interface PortRange {
  readonly start: number; // 0..65535
  readonly end: number; // 0..65535, >= start
}

/** 一条防护规则。 */
export interface Rule {
  /** 唯一整数编号。 */
  readonly id: number;
  /** 优先级，1..1000，数字越小越优先。 */
  readonly priority: number;
  /** 源 IPv4 网段，CIDR 记法，如 "10.0.0.0/8"；主机位不影响网络范围。 */
  readonly cidr: string;
  /** 协议条件：具体协议或 'ANY'。 */
  readonly protocol: Protocol | 'ANY';
  /** 端口条件：闭区间或 'ANY'。 */
  readonly port: PortRange | 'ANY';
  /** 命中后的处置动作。 */
  readonly action: Action;
}

/** 一条待裁决流量记录。ICMP 记录没有端口。 */
export interface TrafficRecord {
  readonly sourceIp: string;
  readonly protocol: Protocol;
  /** TCP/UDP 必填；ICMP 不应携带。 */
  readonly destinationPort?: number;
}

/** 裁决结果。无匹配规则时 action 为 'ALLOW' 且 ruleId 为 null。 */
export interface Verdict {
  readonly ruleId: number | null;
  readonly action: Action;
}
